// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as path from '../platform/vscode-path/path';
import {
    Event,
    EventEmitter,
    NotebookCell,
    NotebookCellData,
    NotebookCellKind,
    NotebookDocument,
    NotebookRange,
    Uri,
    workspace,
    WorkspaceEdit,
    NotebookEditor,
    Disposable,
    window,
    NotebookEdit,
    NotebookEditorRevealType,
    commands,
    TabInputNotebook,
    TabInputInteractiveWindow
} from 'vscode';
import { Commands, MARKDOWN_LANGUAGE, PYTHON_LANGUAGE, isWebExtension } from '../platform/common/constants';
import { logger } from '../platform/logging';
import { IFileSystem } from '../platform/common/platform/types';
import { IConfigurationService, InteractiveWindowMode, Resource } from '../platform/common/types';
import { noop } from '../platform/common/utils/misc';
import { IKernel, IKernelProvider, isLocalConnection, KernelConnectionMetadata } from '../kernels/types';
import { chainable } from '../platform/common/utils/decorators';
import { InteractiveCellResultError } from '../platform/errors/interactiveCellResultError';
import { DataScience } from '../platform/common/utils/localize';
import { createDeferred } from '../platform/common/utils/async';
import { generateUuid } from '../platform/common/uuid';
import { IServiceContainer } from '../platform/ioc/types';
import { createOutputWithErrorMessageForDisplay } from '../platform/errors/errorUtils';
import { INotebookExporter } from '../kernels/jupyter/types';
import { ExportFormat } from '../notebooks/export/types';
import { generateCellsFromNotebookDocument } from './editor-integration/cellFactory';
import { CellMatcher } from './editor-integration/cellMatcher';
import { IInteractiveWindow, IInteractiveWindowDebugger, IInteractiveWindowDebuggingManager } from './types';
import { generateInteractiveCode } from './helpers';
import { getInteractiveCellMetadata } from './helpers';
import { getFilePath } from '../platform/common/platform/fs-paths';
import {
    ICodeGeneratorFactory,
    IGeneratedCodeStorageFactory,
    InteractiveCellMetadata
} from './editor-integration/types';
import { IDataScienceErrorHandler } from '../kernels/errors/types';
import { CellExecutionCreator } from '../kernels/execution/cellExecutionCreator';
import { chainWithPendingUpdates } from '../kernels/execution/notebookUpdater';
import { generateMarkdownFromCodeLines, parseForComments } from '../platform/common/utils';
import { KernelController } from '../kernels/kernelController';
import { splitLines } from '../platform/common/helpers';
import {
    InteractiveWindowController as InteractiveController,
    InteractiveControllerFactory
} from './InteractiveWindowController';
import { getRootFolder } from '../platform/common/application/workspace.base';
import { ExportDialog } from '../notebooks/export/exportDialog';

/**
 * ViewModel for an interactive window from the Jupyter extension's point of view.
 * Methods for talking to an Interactive Window are exposed here, but the actual UI is part of VS code core.
 */
export class InteractiveWindow implements IInteractiveWindow {
    public static lastRemoteSelected: KernelConnectionMetadata | undefined;

    public get onDidChangeViewState(): Event<void> {
        return this._onDidChangeViewState.event;
    }
    public get closed(): Event<void> {
        return this.closedEvent.event;
    }
    public get owner(): Resource {
        return this._owner;
    }
    public get submitters(): Uri[] {
        return this._submitters;
    }
    private _notebookDocument: NotebookDocument | undefined;
    public get notebookDocument(): NotebookDocument | undefined {
        if (!this._notebookDocument) {
            this._notebookDocument = workspace.notebookDocuments.find(
                (nb) => nb.uri.toString() === this.notebookUri.toString()
            );
        }
        return this._notebookDocument;
    }
    public get kernelConnectionMetadata(): KernelConnectionMetadata | undefined {
        return this.controller?.metadata;
    }
    private _onDidChangeViewState = new EventEmitter<void>();
    private closedEvent = new EventEmitter<void>();
    private _submitters: Uri[] = [];
    private cellMatcher: CellMatcher;

    private internalDisposables: Disposable[] = [];

    public readonly notebookUri: Uri;

    private readonly fs: IFileSystem;
    private readonly configuration: IConfigurationService;
    private readonly jupyterExporter: INotebookExporter;
    private readonly interactiveWindowDebugger: IInteractiveWindowDebugger | undefined;
    private readonly errorHandler: IDataScienceErrorHandler;
    private readonly codeGeneratorFactory: ICodeGeneratorFactory;
    private readonly storageFactory: IGeneratedCodeStorageFactory;
    private readonly debuggingManager: IInteractiveWindowDebuggingManager;
    private readonly kernelProvider: IKernelProvider;
    private controller: InteractiveController | undefined;
    constructor(
        private readonly serviceContainer: IServiceContainer,
        private _owner: Resource,
        private readonly controllerFactory: InteractiveControllerFactory,
        notebookEditorOrTabInput: NotebookEditor | TabInputNotebook | TabInputInteractiveWindow,
        public readonly inputUri: Uri
    ) {
        this.fs = this.serviceContainer.get<IFileSystem>(IFileSystem);
        this.configuration = this.serviceContainer.get<IConfigurationService>(IConfigurationService);
        this.jupyterExporter = this.serviceContainer.get<INotebookExporter>(INotebookExporter);
        this.interactiveWindowDebugger =
            this.serviceContainer.tryGet<IInteractiveWindowDebugger>(IInteractiveWindowDebugger);
        this.errorHandler = this.serviceContainer.get<IDataScienceErrorHandler>(IDataScienceErrorHandler);
        this.codeGeneratorFactory = this.serviceContainer.get<ICodeGeneratorFactory>(ICodeGeneratorFactory);
        this.storageFactory = this.serviceContainer.get<IGeneratedCodeStorageFactory>(IGeneratedCodeStorageFactory);
        this.kernelProvider = this.serviceContainer.get<IKernelProvider>(IKernelProvider);
        this.debuggingManager = this.serviceContainer.get<IInteractiveWindowDebuggingManager>(
            IInteractiveWindowDebuggingManager
        );
        this.notebookUri =
            notebookEditorOrTabInput instanceof TabInputInteractiveWindow ||
            notebookEditorOrTabInput instanceof TabInputNotebook
                ? notebookEditorOrTabInput.uri
                : notebookEditorOrTabInput.notebook.uri;

        // Set our owner and first submitter
        if (this._owner) {
            this._submitters.push(this._owner);
        }

        window.onDidChangeActiveNotebookEditor((e) => {
            if (e?.notebook.uri.toString() === this.notebookUri.toString()) {
                this._onDidChangeViewState.fire();
            }
        }, this.internalDisposables);
        workspace.onDidCloseNotebookDocument((notebookDocument) => {
            if (notebookDocument.uri.toString() === this.notebookUri.toString()) {
                this.closedEvent.fire();
            }
        }, this.internalDisposables);

        if (window.activeNotebookEditor?.notebook.uri.toString() === this.notebookUri.toString()) {
            this._onDidChangeViewState.fire();
        }

        this.cellMatcher = new CellMatcher(this.configuration.getSettings(this.owningResource));

        if (this.notebookDocument) {
            this.codeGeneratorFactory.getOrCreate(this.notebookDocument);
        }
    }

    public async notifyConnectionReset() {
        if (!this.notebookDocument) {
            const onNotebookOpen = workspace.onDidOpenNotebookDocument(async (notebook) => {
                if (notebook.uri.toString() === this.notebookUri.toString()) {
                    this._notebookDocument = notebook;
                    this.controller = this.initController();
                    this.internalDisposables.push(this.controller.listenForControllerSelection());
                    this.controller.setInfoMessageCell(DataScience.noKernelConnected);
                    onNotebookOpen.dispose();
                }
            });
        } else {
            if (!this.controller) {
                this.controller = this.initController();
            }
            this.controller.setInfoMessageCell(DataScience.noKernelConnected);
        }
    }

    private initController() {
        const controller = this.controllerFactory.create(this, this.errorHandler, this.kernelProvider, this._owner);
        this.internalDisposables.push(controller.listenForControllerSelection());
        return controller;
    }

    public async ensureInitialized() {
        if (!this.notebookDocument) {
            logger.debug(`Showing Interactive editor to initialize codeGenerator from notebook document`);
            await this.showInteractiveEditor();

            if (!this.notebookDocument) {
                throw new Error('Could not open notebook document for Interactive Window');
            }
        }

        if (!this.codeGeneratorFactory.get(this.notebookDocument)) {
            this.codeGeneratorFactory.getOrCreate(this.notebookDocument);
        }

        if (!this.controller) {
            this.controller = this.initController();
        }

        if (this.controller.controller) {
            this.controller.startKernel().catch(noop);
            await this.controller.resolveSysInfoCell();
        } else {
            logger.info('No controller selected for Interactive Window initialization');
            this.controller.setInfoMessageCell(DataScience.selectKernelForEditor);
        }
    }

    /**
     * Open the the editor for the interactive window, re-using the tab if it already exists.
     */
    public async showInteractiveEditor(): Promise<NotebookEditor> {
        let viewColumn: number | undefined = undefined;
        window.tabGroups.all.find((group) => {
            group.tabs.find((tab) => {
                if (
                    (tab.input instanceof TabInputNotebook || tab.input instanceof TabInputInteractiveWindow) &&
                    tab.input.uri.toString() == this.notebookUri.toString()
                ) {
                    viewColumn = tab.group.viewColumn;
                }
            });
        });

        const notebook = this.notebookDocument || (await this.openNotebookDocument());
        const editor = await window.showNotebookDocument(notebook, {
            preserveFocus: true,
            viewColumn,
            asRepl: true
        });

        return editor;
    }

    private async openNotebookDocument(): Promise<NotebookDocument> {
        logger.debug(`Opening notebook document ${this.notebookUri}`);
        return await workspace.openNotebookDocument(this.notebookUri);
    }

    public dispose() {
        this.internalDisposables.forEach((d) => d.dispose());
        this.controller?.disconnect();
    }

    @chainable()
    async showErrorForCell(message: string, notebookCell: NotebookCell): Promise<void> {
        const controller = this.controller?.controller;
        const output = createOutputWithErrorMessageForDisplay(message);
        if (controller && output && notebookCell) {
            const execution = CellExecutionCreator.getOrCreate(notebookCell, new KernelController(controller));
            try {
                await execution.appendOutput(output);
            } catch (err) {
                logger.warn(`Could not append error message "${output}" to cell: ${err}`);
            } finally {
                execution.end(false, notebookCell.executionSummary?.timing?.endTime);
            }
        } else {
            logger.info(`Could not append error message to cell "${output}"`);
        }
    }

    public changeMode(mode: InteractiveWindowMode): void {
        this.controller?.updateMode(mode);
    }

    public async addCode(code: string, file: Uri, line: number): Promise<boolean> {
        return this.submitCode(code, file, line, false);
    }

    private useNewDebugMode(): boolean {
        const settings = this.configuration.getSettings(this.owner);
        return !!(
            settings.forceIPyKernelDebugger ||
            (this.controller?.metadata && !isLocalConnection(this.controller.metadata))
        );
    }

    public async debugCode(code: string, fileUri: Uri, line: number): Promise<boolean> {
        let saved = true;
        // Make sure the file is saved before debugging
        const doc = workspace.textDocuments.find((d) => this.fs.arePathsSame(d.uri, fileUri));
        if (!this.useNewDebugMode() && doc && doc.isUntitled) {
            // Before we start, get the list of documents
            const beforeSave = [...workspace.textDocuments];

            saved = await doc.save();

            // If that worked, we have to open the new document. It should be
            // the new entry in the list
            if (saved) {
                const diff = workspace.textDocuments.filter((f) => beforeSave.indexOf(f) === -1);
                if (diff && diff.length > 0) {
                    // The interactive window often opens at the same time. Avoid picking that one.
                    // Another unrelated window could open at the same time too.
                    const savedFileEditor =
                        diff.find((doc) => doc.languageId === 'python') ||
                        diff.find((doc) => !doc.fileName.endsWith('.interactive')) ||
                        diff[0];
                    fileUri = savedFileEditor.uri;

                    // Open the new document
                    await workspace.openTextDocument(fileUri);
                }
            }
        }

        let result = true;

        // Call the internal method if we were able to save
        if (saved) {
            return this.submitCode(code, fileUri, line, true);
        }

        return result;
    }

    private async submitCode(code: string, fileUri: Uri, line: number, isDebug: boolean) {
        // Do not execute or render empty cells
        if (this.cellMatcher.isEmptyCell(code) || !this.controller?.controller) {
            return true;
        }

        // Update the owner list ASAP (this is before we execute)
        this.updateOwners(fileUri);

        // Code may have markdown inside of it, if so, split into two cells
        const split = splitLines(code, { trim: false });
        const matcher = new CellMatcher(this.configuration.getSettings(fileUri));
        let firstNonMarkdown = -1;
        if (matcher.isMarkdown(split[0])) {
            parseForComments(
                split,
                (_s, _i) => noop(),
                (s, i) => {
                    // Make sure there's actually some code.
                    if (s && s.length > 0 && firstNonMarkdown === -1) {
                        firstNonMarkdown = i;
                    }
                }
            );
        }

        const cells =
            firstNonMarkdown > 0
                ? [split.slice(0, firstNonMarkdown).join('\n'), split.slice(firstNonMarkdown).join('\n')]
                : [code];

        // Multiple cells that have split our code.
        const promises = cells.map((c) => {
            const deferred = createDeferred<void>();
            this.controller!.setPendingCellAdd(deferred.promise);
            // Add the cell first. We don't need to wait for this part as we want to add them
            // as quickly as possible
            const notebookCellPromise = this.addNotebookCell(c, fileUri, line);

            // Queue up execution
            const promise = this.createExecutionPromise(notebookCellPromise, isDebug);
            promise
                .catch((ex) => {
                    // If execution fails due to a failure in another cell, then log that error against the cell.
                    if (ex instanceof InteractiveCellResultError) {
                        notebookCellPromise
                            .then((cell) => {
                                if (ex.cell !== cell) {
                                    this.showErrorForCell(DataScience.cellStopOnErrorMessage, cell).then(noop, noop);
                                }
                            })
                            .catch(noop);
                    } else {
                        notebookCellPromise
                            .then((cell) =>
                                // If our cell result was a failure show an error
                                this.errorHandler
                                    .getErrorMessageForDisplayInCellOutput(ex, 'execution', this.owningResource)
                                    .then((message) => this.showErrorForCell(message, cell))
                            )
                            .catch(noop);
                    }
                })
                .finally(() => {
                    deferred?.resolve();
                });
            return promise;
        });

        // Last promise should be when we're all done submitting.
        return promises[promises.length - 1];
    }

    @chainable()
    private async createExecutionPromise(notebookCellPromise: Promise<NotebookCell>, isDebug: boolean) {
        if (!this.controller || !this.notebookDocument) {
            return false;
        }
        logger.ci('InteractiveWindow.ts.createExecutionPromise.start');
        // Kick of starting kernels early.
        const kernelPromise = this.controller.startKernel();
        const cell = await notebookCellPromise;

        let success = true;
        let detachKernel = async () => noop();
        try {
            const kernel = await kernelPromise;
            await this.generateCodeAndAddMetadata(cell, isDebug, kernel);
            if (isDebug && this.useNewDebugMode()) {
                // New ipykernel 7 debugger using the Jupyter protocol.
                await this.debuggingManager.start(this.notebookDocument, cell);
            } else if (
                isDebug &&
                isLocalConnection(kernel.kernelConnectionMetadata) &&
                this.interactiveWindowDebugger
            ) {
                // Old ipykernel 6 debugger.
                // If debugging attach to the kernel but don't enable tracing just yet
                detachKernel = async () => this.interactiveWindowDebugger?.detach(kernel);
                await this.interactiveWindowDebugger.attach(kernel);
                await this.interactiveWindowDebugger.updateSourceMaps(
                    this.storageFactory.get({ notebook: cell.notebook })?.all || []
                );
                this.interactiveWindowDebugger.enable(kernel);
            }
            logger.ci('InteractiveWindow.ts.createExecutionPromise.kernel.executeCell');
            const iwCellMetadata = getInteractiveCellMetadata(cell);
            const execution = this.kernelProvider.getKernelExecution(kernel!);
            success = await execution.executeCell(cell, iwCellMetadata?.generatedCode?.code).then(
                () => true,
                () => false
            );
            logger.ci('InteractiveWindow.ts.createExecutionPromise.kernel.executeCell.finished');
        } finally {
            await detachKernel();
            logger.ci('InteractiveWindow.ts.createExecutionPromise.end');
        }

        if (!success) {
            // Throw to break out of the promise chain
            throw new InteractiveCellResultError(cell);
        }
        return success;
    }

    public async expandAllCells() {
        if (this.notebookDocument) {
            await Promise.all(
                this.notebookDocument.getCells().map(async (_cell, index) => {
                    await commands.executeCommand('notebook.cell.expandCellInput', {
                        ranges: [{ start: index, end: index + 1 }],
                        document: this.notebookUri
                    });
                })
            );
        }
    }

    public async collapseAllCells() {
        if (this.notebookDocument) {
            await Promise.all(
                this.notebookDocument.getCells().map(async (cell, index) => {
                    if (cell.kind !== NotebookCellKind.Code) {
                        return;
                    }
                    await commands.executeCommand('notebook.cell.collapseCellInput', {
                        ranges: [{ start: index, end: index + 1 }],
                        document: this.notebookUri
                    });
                })
            );
        }
    }

    public async scrollToCell(id: string): Promise<void> {
        const editor = await this.showInteractiveEditor();
        const matchingCell = editor.notebook.getCells().find((cell) => getInteractiveCellMetadata(cell)?.id === id);
        if (matchingCell) {
            const notebookRange = new NotebookRange(matchingCell.index, matchingCell.index + 1);
            editor.revealRange(notebookRange, NotebookEditorRevealType.Default);
            editor.selection = notebookRange;
        }
    }

    public async hasCell(id: string): Promise<boolean> {
        const notebook = this.notebookDocument;
        return !!notebook && notebook.getCells().some((cell) => getInteractiveCellMetadata(cell)?.id === id);
    }

    public get owningResource(): Resource {
        if (this.owner) {
            return this.owner;
        }
        const root = getRootFolder();
        if (root) {
            return root;
        }
        return undefined;
    }

    private updateOwners(file: Uri) {
        // Update the owner for this window if not already set
        if (!this._owner) {
            this._owner = file;
            this.controller?.updateOwners(file);
        }

        // Add to the list of 'submitters' for this window.
        if (!this._submitters.find((s) => s.toString() == file.toString())) {
            this._submitters.push(file);
        }
    }

    private async addNotebookCell(code: string, file: Uri, line: number): Promise<NotebookCell> {
        const notebookDocument = this.notebookDocument;
        if (!notebookDocument) {
            throw new Error('No notebook document');
        }

        // Strip #%% and store it in the cell metadata so we can reconstruct the cell structure when exporting to Python files
        const settings = this.configuration.getSettings(this.owningResource);
        const isMarkdown = this.cellMatcher.getCellType(code) === MARKDOWN_LANGUAGE;
        const strippedCode = isMarkdown
            ? generateMarkdownFromCodeLines(splitLines(code)).join('')
            : generateInteractiveCode(code, settings, this.cellMatcher);
        const interactiveWindowCellMarker = this.cellMatcher.getFirstMarker(code);

        // Insert cell into NotebookDocument
        const language =
            workspace.textDocuments.find((document) => document.uri.toString() === this.owner?.toString())
                ?.languageId ?? PYTHON_LANGUAGE;
        const notebookCellData = new NotebookCellData(
            isMarkdown ? NotebookCellKind.Markup : NotebookCellKind.Code,
            strippedCode,
            isMarkdown ? MARKDOWN_LANGUAGE : language
        );
        const interactive = {
            uristring: file.toString(), // Has to be simple types
            lineIndex: line,
            originalSource: code
        };

        const metadata: InteractiveCellMetadata = {
            interactiveWindowCellMarker,
            interactive,
            id: generateUuid()
        };
        notebookCellData.metadata = metadata;

        let index: number | undefined;
        await chainWithPendingUpdates(notebookDocument, async (edit) => {
            index = await this.getAppendIndex();
            const nbEdit = NotebookEdit.insertCells(index, [notebookCellData]);
            edit.set(notebookDocument.uri, [nbEdit]);
        });
        return notebookDocument.cellAt(index!);
    }

    public async getAppendIndex() {
        if (!this.notebookDocument) {
            throw new Error('No notebook document');
        }
        return this.notebookDocument.cellCount;
    }

    private async generateCodeAndAddMetadata(cell: NotebookCell, isDebug: boolean, kernel: IKernel) {
        const metadata = getInteractiveCellMetadata(cell);
        if (!metadata) {
            return;
        }
        const forceIPyKernelDebugger =
            !isLocalConnection(kernel.kernelConnectionMetadata) ||
            this.configuration.getSettings(undefined).forceIPyKernelDebugger;

        const generatedCode = await this.codeGeneratorFactory
            .getOrCreate(this.notebookDocument!)
            .generateCode(metadata, cell.index, isDebug, forceIPyKernelDebugger);

        const newMetadata: typeof metadata = {
            ...metadata,
            generatedCode
        };

        const edit = new WorkspaceEdit();
        const cellEdit = NotebookEdit.updateCellMetadata(cell.index, newMetadata);
        edit.set(cell.notebook.uri, [cellEdit]);
        await workspace.applyEdit(edit);
    }

    public async export() {
        if (!this.notebookDocument) {
            throw new Error('no notebook to export.');
        }
        const cells = generateCellsFromNotebookDocument(this.notebookDocument);

        // Bring up the export file dialog box
        const uri = await new ExportDialog().showDialog(ExportFormat.ipynb, this.owningResource);
        if (uri) {
            await this.jupyterExporter?.exportToFile(cells, getFilePath(uri));
        }
    }

    public async exportAs() {
        await this.ensureInitialized();
        if (!this.controller) {
            throw new Error('An active kernel is required to export the notebook.');
        }
        const kernel = this.controller.kernel?.value;

        let defaultFileName;
        if (this.submitters && this.submitters.length) {
            const lastSubmitter = this.submitters[this.submitters.length - 1];
            lastSubmitter;
            defaultFileName = path.basename(lastSubmitter.path, path.extname(lastSubmitter.path));
        }

        // Then run the export command with these contents
        if (isWebExtension()) {
            // In web, we currently only support exporting as python script
            commands
                .executeCommand(
                    Commands.ExportAsPythonScript,
                    this.notebookDocument,
                    kernel?.kernelConnectionMetadata.interpreter
                )
                .then(noop, noop);
        } else {
            commands
                .executeCommand(
                    Commands.Export,
                    this.notebookDocument,
                    defaultFileName,
                    kernel?.kernelConnectionMetadata.interpreter
                )
                .then(noop, noop);
        }
    }
}
