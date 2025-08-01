// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Kernel, KernelMessage } from '@jupyterlab/services';
import { Event, EventEmitter, NotebookDocument } from 'vscode';
import type { Data as WebSocketData } from 'ws';
import { logger } from '../../../../platform/logging';
import { Identifiers, WIDGET_MIMETYPE } from '../../../../platform/common/constants';
import { IDisposable } from '../../../../platform/common/types';
import { Deferred, createDeferred } from '../../../../platform/common/utils/async';
import { noop } from '../../../../platform/common/utils/misc';
import { deserializeDataViews, serializeDataViews } from '../../../../platform/common/utils/serializers';
import { IPyWidgetMessages, IInteractiveWindowMapping } from '../../../../messageTypes';
import { IKernel, IKernelProvider, type IKernelSocket } from '../../../../kernels/types';
import { IIPyWidgetMessageDispatcher, IPyWidgetMessage } from '../types';
import { shouldMessageBeMirroredWithRenderer } from '../../../../kernels/kernel';
import { KernelSocketMap } from '../../../../kernels/kernelSocket';
import type { IDisplayDataMsg } from '@jupyterlab/services/lib/kernel/messages';
import { generateUuid } from '../../../../platform/common/uuid';

type PendingMessage = {
    resultPromise: Deferred<void>;
    startTime: number;
};

const kernelCommTargets = new WeakMap<
    Kernel.IKernelConnection,
    { targets: Set<string>; registerCommTarget: (targetName: string) => void }
>();

export function registerCommTargetFor3rdPartyExtensions(kernel: Kernel.IKernelConnection, targetName: string) {
    const targets = kernelCommTargets.get(kernel);
    if (targets) {
        targets.targets.add(targetName);
        targets.registerCommTarget(targetName);
    }
}

export function removeCommTargetFor3rdPartyExtensions(kernel: Kernel.IKernelConnection, targetName: string) {
    kernelCommTargets.get(kernel)?.targets?.delete?.(targetName);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * This class maps between messages from the react code and talking to a real kernel.
 */
export class IPyWidgetMessageDispatcher implements IIPyWidgetMessageDispatcher {
    public get postMessage(): Event<IPyWidgetMessage> {
        return this._postMessageEmitter.event;
    }
    private readonly commTargetsRegistered = new Set<string>();
    private jupyterLab?: typeof import('@jupyterlab/services');
    private pendingTargetNames = new Set<string>();
    private kernel?: IKernel;
    private _postMessageEmitter = new EventEmitter<IPyWidgetMessage>();
    private _onDisplayMessage = new EventEmitter<IDisplayDataMsg>();
    public readonly onDisplayMessage = this._onDisplayMessage.event;
    private messageHooks = new Map<string, (msg: KernelMessage.IIOPubMessage) => boolean | PromiseLike<boolean>>();
    private pendingHookRemovals = new Map<string, string>();
    private messageHookRequests = new Map<string, Deferred<boolean>>();

    private readonly disposables: IDisposable[] = [];
    private kernelRestartHandlerAttached?: boolean;
    private kernelWasConnectedAtLeastOnce?: boolean;
    private disposed = false;
    private pendingMessages: string[] = [];
    private subscribedToKernelSocket: boolean = false;
    private waitingMessageIds = new Map<string, PendingMessage>();
    /**
     * The Output widget's model can set up or tear down a kernel message hook on state change.
     * We need to wait until the kernel message hook has been connected before it's safe to send
     * more messages to the UI kernel.
     *
     * To do this we:
     * - Keep track of the id of all the Output widget models in the outputWidgetIds instance variable.
     *   We add/remove these ids by inspecting messages in onKernelSocketMessage.
     * - When a state update message is sent to one of these widgets, we synchronize with the UI and
     *   stop sending messages until we receive a reply indicating that the state change has been fully handled.
     *   We keep track of the message we're waiting for in the fullHandleMessage instance variable.
     *   We start waiting for the state change to finish processing in onKernelSocketMessage,
     *   and we stop waiting in iopubMessageHandled.
     */
    private outputWidgetIds = new Set<string>();
    private fullHandleMessage?: { id: string; promise: Deferred<void> };
    private isUsingIPyWidgets = false;
    private readonly deserialize: (data: ArrayBuffer, protocol?: string) => KernelMessage.IMessage;

    constructor(
        private readonly kernelProvider: IKernelProvider,
        public readonly document: NotebookDocument
    ) {
        // Always register this comm target.
        // Possible auto start is disabled, and when cell is executed with widget stuff, this comm target will not have
        // been registered, in which case kaboom. As we know this is always required, pre-register this.
        this.pendingTargetNames.add('jupyter.widget');
        kernelProvider.onDidStartKernel(
            (e) => {
                if (e.notebook === document) {
                    this.initialize();
                }
            },
            this,
            this.disposables
        );
        this.mirrorSend = this.mirrorSend.bind(this);
        this.onKernelSocketMessage = this.onKernelSocketMessage.bind(this);
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const jupyterLabSerialize =
            require('@jupyterlab/services/lib/kernel/serialize') as typeof import('@jupyterlab/services/lib/kernel/serialize'); // NOSONAR
        this.deserialize = jupyterLabSerialize.deserialize;
    }
    public dispose() {
        this.disposed = true;
        while (this.disposables.length) {
            const disposable = this.disposables.shift();
            disposable?.dispose(); // NOSONAR
        }
    }

    public receiveMessage(message: IPyWidgetMessage): void {
        switch (message.message) {
            case IPyWidgetMessages.IPyWidgets_logMessage: {
                const payload: IInteractiveWindowMapping[IPyWidgetMessages.IPyWidgets_logMessage] = message.payload;
                if (payload.category === 'error') {
                    logger.error(`Widget Error: ${payload.message}`);
                } else {
                    logger.trace(`Widget Message: ${payload.message}`);
                }
                break;
            }
            case IPyWidgetMessages.IPyWidgets_Ready:
                this.sendKernelOptions();
                this.initialize();
                break;
            case IPyWidgetMessages.IPyWidgets_msg:
                this.sendRawPayloadToKernelSocket(message.payload);
                break;
            case IPyWidgetMessages.IPyWidgets_binary_msg:
                this.sendRawPayloadToKernelSocket(deserializeDataViews(message.payload)![0]);
                break;

            case IPyWidgetMessages.IPyWidgets_msg_received:
                this.onKernelSocketResponse(message.payload);
                break;

            case IPyWidgetMessages.IPyWidgets_registerCommTarget:
                this.registerCommTarget(message.payload);
                break;

            case IPyWidgetMessages.IPyWidgets_RegisterMessageHook:
                this.registerMessageHook(message.payload);
                break;

            case IPyWidgetMessages.IPyWidgets_RemoveMessageHook:
                this.possiblyRemoveMessageHook(message.payload);
                break;

            case IPyWidgetMessages.IPyWidgets_MessageHookResult:
                this.handleMessageHookResponse(message.payload);
                break;

            case IPyWidgetMessages.IPyWidgets_iopub_msg_handled:
                this.iopubMessageHandled(message.payload);
                break;

            default:
                break;
        }
    }
    public sendRawPayloadToKernelSocket(payload?: any) {
        this.pendingMessages.push(payload);
        this.sendPendingMessages();
    }
    public registerCommTarget(targetName: string) {
        this.pendingTargetNames.add(targetName);
        this.initialize();
    }

    public initialize() {
        if (!this.jupyterLab) {
            // Lazy load jupyter lab for faster extension loading.
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            this.jupyterLab = require('@jupyterlab/services') as typeof import('@jupyterlab/services'); // NOSONAR
        }

        // If we have any pending targets, register them now
        const kernel = this.getKernel();
        if (kernel) {
            this.subscribeToKernelSocket(kernel);
            this.registerCommTargets(kernel);
        }
    }
    protected raisePostMessage<M extends IInteractiveWindowMapping, T extends keyof IInteractiveWindowMapping>(
        message: IPyWidgetMessages,
        payload: M[T]
    ) {
        this._postMessageEmitter.fire({ message, payload });
    }
    private subscribeToKernelSocket(kernel: IKernel) {
        if (this.subscribedToKernelSocket || !kernel.session) {
            return;
        }
        this.subscribedToKernelSocket = true;
        this.subscribeToKernelSocketImpl(kernel);
        // Listen to changes to kernel socket (e.g. restarts or changes to kernel).
        let oldKernelId = kernel.session.kernel?.id;

        kernel.session.onDidKernelSocketChange(() => {
            this.subscribeToKernelSocketImpl(kernel, oldKernelId);
            oldKernelId = kernel.session?.kernel?.id || '';
        });
    }
    private readonly kernelSocketHandlers = new WeakMap<
        IKernelSocket,
        {
            receiveHook: (data: WebSocketData) => Promise<void>;
            sendHook: (data: any, _cb?: (err?: Error) => void) => Promise<void>;
        }
    >();
    private subscribeToKernelSocketImpl(kernel: IKernel, oldKernelId?: string) {
        // Remove old handlers.
        const oldSocket = oldKernelId ? KernelSocketMap.get(oldKernelId) : undefined;
        const handlers = oldSocket ? this.kernelSocketHandlers.get(oldSocket) : undefined;
        if (handlers?.receiveHook) {
            oldSocket?.removeReceiveHook(handlers.receiveHook); // NOSONAR
        }
        if (handlers?.sendHook) {
            oldSocket?.removeSendHook(handlers.sendHook); // NOSONAR
        }
        if (this.kernelWasConnectedAtLeastOnce) {
            // this means we restarted the kernel and we now have new information.
            // Discard all of the messages upto this point.
            while (this.pendingMessages.length) {
                this.pendingMessages.shift();
            }
            this.waitingMessageIds.forEach((d) => d.resultPromise.resolve());
            this.waitingMessageIds.clear();
            this.messageHookRequests.forEach((m) => m.resolve(false));
            this.messageHookRequests.clear();
            this.messageHooks.clear();
            this.sendRestartKernel();
        }
        if (!kernel.session?.kernel?.id || !KernelSocketMap.get(kernel.session?.kernel?.id)) {
            // No kernel socket information, hence nothing much we can do.
            return;
        }

        if (!kernelCommTargets.has(kernel.session.kernel)) {
            kernelCommTargets.set(kernel.session.kernel, {
                targets: new Set<string>(),
                registerCommTarget: (targetName: string) => {
                    this.raisePostMessage(IPyWidgetMessages.IPyWidgets_registerCommTarget, targetName);
                }
            });
        }

        this.kernelWasConnectedAtLeastOnce = true;
        const kernelId = kernel.session.kernel?.id;
        const newSocket = kernelId ? KernelSocketMap.get(kernelId) : undefined;
        const protocol = newSocket?.protocol || '';
        if (newSocket) {
            const onKernelSocketMessage = this.onKernelSocketMessage.bind(this, protocol);
            const mirrorSend = this.mirrorSend.bind(this, protocol);
            newSocket.addReceiveHook(onKernelSocketMessage); // NOSONAR
            newSocket.addSendHook(mirrorSend); // NOSONAR
            this.kernelSocketHandlers.set(newSocket, { receiveHook: onKernelSocketMessage, sendHook: mirrorSend });
        }
        this.sendKernelOptions(protocol);
        // Since we have connected to a kernel, send any pending messages.
        this.registerCommTargets(kernel);
        this.sendPendingMessages(protocol);
    }
    /**
     * Pass this information to UI layer so it can create a dummy kernel with same information.
     * Information includes kernel connection info (client id, user name, model, etc).
     */
    private sendKernelOptions(protocol: string = '') {
        const kernel = this.kernel?.session?.kernel;
        if (!kernel) {
            return;
        }

        if (!protocol) {
            protocol = KernelSocketMap.get(kernel.id)?.protocol || '';
        }

        this.raisePostMessage(IPyWidgetMessages.IPyWidgets_kernelOptions, {
            id: kernel.id,
            clientId: kernel.clientId || '',
            userName: kernel.username || '',
            model: kernel.model || { id: '', name: '' },
            protocol
        });
    }
    private async mirrorSend(protocol: string | undefined, data: any, _cb?: (err?: Error) => void): Promise<void> {
        // If this is shell control message, mirror to the other side. This is how
        // we get the kernel in the UI to have the same set of futures we have on this side
        if (typeof data === 'string' && data.includes('shell') && data.includes('execute_request')) {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const msg =
                typeof data === 'string'
                    ? JSON.parse(data)
                    : (this.deserialize(data) as KernelMessage.IExecuteRequestMsg);
            if (msg.channel === 'shell' && msg.header.msg_type === 'execute_request') {
                if (!shouldMessageBeMirroredWithRenderer(msg)) {
                    return;
                }
                const promise = this.mirrorExecuteRequest(msg as KernelMessage.IExecuteRequestMsg); // NOSONAR
                // If there are no ipywidgets thusfar in the notebook, then no need to synchronize messages.
                if (this.isUsingIPyWidgets) {
                    await promise;
                }
            }
        } else if (typeof data !== 'string') {
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const msg = this.deserialize(data, protocol) as KernelMessage.IExecuteRequestMsg;
                // const msg =  this.deserialize(data) as KernelMessage.IExecuteRequestMsg;
                if (msg.channel === 'shell' && msg.header.msg_type === 'execute_request') {
                    if (!shouldMessageBeMirroredWithRenderer(msg)) {
                        return;
                    }
                    const promise = this.mirrorExecuteRequest(msg as KernelMessage.IExecuteRequestMsg); // NOSONAR
                    // If there are no ipywidgets thusfar in the notebook, then no need to synchronize messages.
                    if (this.isUsingIPyWidgets) {
                        await promise;
                    }
                }
            } catch (ex) {
                logger.error('Failed to mirror message to kernel', ex);
            }
        }
    }

    private sendRestartKernel() {
        this.raisePostMessage(IPyWidgetMessages.IPyWidgets_onRestartKernel, undefined);
    }

    private mirrorExecuteRequest(msg: KernelMessage.IExecuteRequestMsg) {
        const promise = createDeferred<void>();
        this.waitingMessageIds.set(msg.header.msg_id, { startTime: Date.now(), resultPromise: promise });
        this.raisePostMessage(IPyWidgetMessages.IPyWidgets_mirror_execute, { id: msg.header.msg_id, msg });
        return promise.promise;
    }

    // Determine if a message can just be added into the message queue or if we need to wait for it to be
    // fully handled on both the UI and extension side before we process the next message incoming
    private messageNeedsFullHandle(message: any) {
        // We only get a handled callback for iopub messages, so this channel must be iopub
        return (
            message.channel === 'iopub' &&
            message.header?.msg_type === 'comm_msg' &&
            message.content?.data?.method === 'update' &&
            this.outputWidgetIds.has(message.content?.comm_id)
        );
    }

    // Callback from the UI kernel when an iopubMessage has been fully handled
    private iopubMessageHandled(payload: any) {
        const msgId = payload.id;
        // We don't fully handle all iopub messages, so check our id here
        if (this.fullHandleMessage && this.fullHandleMessage.id === msgId) {
            this.fullHandleMessage.promise.resolve();
            this.fullHandleMessage = undefined;
        }
    }
    private async onKernelSocketMessage(protocol: string | undefined, data: WebSocketData): Promise<void> {
        // Hooks expect serialized data as this normally comes from a WebSocket

        const msgUuid = generateUuid();
        const promise = createDeferred<void>();
        this.waitingMessageIds.set(msgUuid, { startTime: Date.now(), resultPromise: promise });
        let deserializedMessage: KernelMessage.IMessage | undefined = undefined;
        if (typeof data === 'string') {
            if (shouldMessageBeMirroredWithRenderer(data)) {
                this.raisePostMessage(IPyWidgetMessages.IPyWidgets_msg, { id: msgUuid, data });
                if (data.includes('display_data')) {
                    deserializedMessage = this.deserialize(data as any, protocol);
                    const jupyterLab = require('@jupyterlab/services') as typeof import('@jupyterlab/services');
                    if (jupyterLab.KernelMessage.isDisplayDataMsg(deserializedMessage)) {
                        this._onDisplayMessage.fire(deserializedMessage);
                    }
                }
            }
        } else {
            const dataToSend = serializeDataViews([data as any]);
            const deSerialized = deserializeDataViews(dataToSend);
            console.error(dataToSend, deSerialized);
            this.raisePostMessage(IPyWidgetMessages.IPyWidgets_binary_msg, {
                id: msgUuid,
                data: serializeDataViews([data as any])
            });
        }

        // Lets deserialize only if we know we have a potential case
        // where this message contains some data we're interested in.
        const mustDeserialize =
            typeof data !== 'string' ||
            data.includes(WIDGET_MIMETYPE) ||
            data.includes(Identifiers.DefaultCommTarget) ||
            data.includes('comm_open') ||
            data.includes('comm_close') ||
            data.includes('comm_msg');
        if (mustDeserialize) {
            const message = deserializedMessage || (this.deserialize(data as any, protocol) as any);
            if (!shouldMessageBeMirroredWithRenderer(message)) {
                return;
            }

            // Check for hints that would indicate whether ipywidgest are used in outputs.
            if (
                message &&
                message.content &&
                message.content.data &&
                (message.content.data[WIDGET_MIMETYPE] || message.content.target_name === Identifiers.DefaultCommTarget)
            ) {
                this.isUsingIPyWidgets = true;
            }

            const isIPYWidgetOutputModelOpen =
                message.header?.msg_type === 'comm_open' &&
                message.content?.data?.state?._model_module === '@jupyter-widgets/output' &&
                message.content?.data?.state?._model_name === 'OutputModel';
            const isIPYWidgetOutputModelClose =
                message.header?.msg_type === 'comm_close' && this.outputWidgetIds.has(message.content?.comm_id);

            if (isIPYWidgetOutputModelOpen) {
                this.outputWidgetIds.add(message.content.comm_id);
            } else if (isIPYWidgetOutputModelClose) {
                this.outputWidgetIds.delete(message.content.comm_id);
            } else if (this.messageNeedsFullHandle(message)) {
                this.fullHandleMessage = { id: message.header.msg_id, promise: createDeferred<void>() };
                await promise.promise;
                await this.fullHandleMessage.promise.promise;
                this.fullHandleMessage = undefined;
            }
        }
    }
    private onKernelSocketResponse(payload: { id: string }) {
        const pending = this.waitingMessageIds.get(payload.id);
        if (pending) {
            this.waitingMessageIds.delete(payload.id);
            pending.resultPromise.resolve();
        }
    }
    private sendPendingMessages(protocol: string = '') {
        if (!this.kernel?.session?.kernel) {
            return;
        }
        if (!protocol) {
            protocol = KernelSocketMap.get(this.kernel.session.kernel.id)?.protocol || '';
        }
        while (this.pendingMessages.length) {
            try {
                const message = this.pendingMessages[0];
                // If we do not have a string, then its a binary message.
                // This happens only when there are some array buffers (binary data) in the message.
                // Thats why we need to first deserialize the binary into JSON.
                const msg: KernelMessage.IMessage =
                    typeof message === 'string' ? JSON.parse(message) : this.deserialize(message, protocol);
                // However the buffers can be DataViewers
                // When sending to the kernel, we need to convert them to ArrayBuffer
                if (msg.buffers?.length) {
                    msg.buffers = msg.buffers.map((buffer) => {
                        if (buffer instanceof DataView) {
                            // The underlying buffer is an ArrayBuffer,
                            // & thats what needs to be sent to the kernel.
                            // One simple test is FileUpload widget.
                            return buffer.buffer;
                        }
                        return buffer;
                    });
                }
                if (msg.channel === 'control') {
                    this.kernel.session.kernel!.sendControlMessage(msg as unknown as KernelMessage.IControlMessage);
                } else {
                    this.kernel.session.kernel!.sendShellMessage(msg as unknown as KernelMessage.IShellMessage);
                }
                // The only other message that can be send is an input reply,
                // However widgets do not support that, as input requests are handled by the extension host kernel
                // & not the widget (renderer/webview side) kernel
                this.pendingMessages.shift();
            } catch (ex) {
                logger.error('Failed to send message to Kernel', ex);
                return;
            }
        }
    }

    private registerCommTargets(kernel: IKernel) {
        while (this.pendingTargetNames.size > 0) {
            const targetNames = Array.from([...this.pendingTargetNames.values()]);
            const targetName = targetNames.shift();
            if (!targetName) {
                continue;
            }
            if (this.commTargetsRegistered.has(targetName)) {
                // Already registered.
                return;
            }

            logger.trace(`Registering commtarget ${targetName}`);
            this.commTargetsRegistered.add(targetName);
            this.pendingTargetNames.delete(targetName);

            // Skip the predefined target. It should have been registered
            // inside the kernel on startup. However we
            // still need to track it here.
            if (
                kernel.session?.kernel &&
                targetName !== Identifiers.DefaultCommTarget &&
                !kernelCommTargets.get(kernel.session.kernel)?.targets?.has(targetName)
            ) {
                kernel.session.kernel.registerCommTarget(targetName, noop);
            }
        }
    }

    private getKernel(): IKernel | undefined {
        if (this.document && !this.kernel?.session) {
            this.kernel = this.kernelProvider.get(this.document);
            this.kernel?.onDisposed(() => (this.kernel = undefined));
        }
        if (this.kernel && !this.kernelRestartHandlerAttached) {
            this.kernelRestartHandlerAttached = true;
            this.disposables.push(this.kernel.onRestarted(this.handleKernelRestarts, this));
        }
        return this.kernel;
    }
    /**
     * When a kernel restarts, we need to ensure the comm targets are re-registered.
     * This must happen before anything else is processed.
     */
    private async handleKernelRestarts() {
        if (this.disposed || this.commTargetsRegistered.size === 0 || !this.kernel?.session) {
            return;
        }
        // Ensure we re-register the comm targets.
        Array.from(this.commTargetsRegistered.keys()).forEach((targetName) => {
            this.commTargetsRegistered.delete(targetName);
            this.pendingTargetNames.add(targetName);
        });

        this.subscribeToKernelSocket(this.kernel);
        this.registerCommTargets(this.kernel);
    }

    private registerMessageHook(msgId: string) {
        try {
            if (this.kernel?.session?.kernel && !this.messageHooks.has(msgId)) {
                const callback = this.messageHookCallback.bind(this);
                this.messageHooks.set(msgId, callback);
                this.kernel.session.kernel.registerMessageHook(msgId, callback);
            }
        } finally {
            // Regardless of if we registered successfully or not, send back a message to the UI
            // that we are done with extension side handling of this message
            this.raisePostMessage(IPyWidgetMessages.IPyWidgets_ExtensionOperationHandled, {
                id: msgId,
                type: IPyWidgetMessages.IPyWidgets_RegisterMessageHook
            });
        }
    }

    private possiblyRemoveMessageHook(args: { hookMsgId: string; lastHookedMsgId: string | undefined }) {
        // Message hooks might need to be removed after a certain message is processed.
        try {
            if (args.lastHookedMsgId) {
                this.pendingHookRemovals.set(args.lastHookedMsgId, args.hookMsgId);
            } else {
                this.removeMessageHook(args.hookMsgId);
            }
        } finally {
            // Regardless of if we removed the hook, added to pending removals or just failed, send back a message to the UI
            // that we are done with extension side handling of this message
            this.raisePostMessage(IPyWidgetMessages.IPyWidgets_ExtensionOperationHandled, {
                id: args.hookMsgId,
                type: IPyWidgetMessages.IPyWidgets_RemoveMessageHook
            });
        }
    }

    private removeMessageHook(msgId: string) {
        if (this.kernel?.session?.kernel && this.messageHooks.has(msgId)) {
            const callback = this.messageHooks.get(msgId);
            this.messageHooks.delete(msgId);
            this.kernel.session.kernel.removeMessageHook(msgId, callback!);
        }
    }

    private async messageHookCallback(msg: KernelMessage.IIOPubMessage): Promise<boolean> {
        const promise = createDeferred<boolean>();
        const requestId = generateUuid();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const parentId = (msg.parent_header as any).msg_id;
        if (this.messageHooks.has(parentId)) {
            this.messageHookRequests.set(requestId, promise);
            this.raisePostMessage(IPyWidgetMessages.IPyWidgets_MessageHookCall, { requestId, parentId, msg });
        } else {
            promise.resolve(true);
        }

        // Might have a pending removal. We may have delayed removing a message hook until a message was actually
        // processed.
        if (this.pendingHookRemovals.has(msg.header.msg_id)) {
            const hookId = this.pendingHookRemovals.get(msg.header.msg_id);
            this.pendingHookRemovals.delete(msg.header.msg_id);
            this.removeMessageHook(hookId!);
        }

        return promise.promise;
    }

    private handleMessageHookResponse(args: { requestId: string; parentId: string; msgType: string; result: boolean }) {
        const promise = this.messageHookRequests.get(args.requestId);
        if (promise) {
            this.messageHookRequests.delete(args.requestId);

            // During a comm message, make sure all messages come out.
            promise.resolve(args.msgType.includes('comm') ? true : args.result);
        }
    }
}
