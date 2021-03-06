import * as msgpack from './msgpack';
import { createSignal } from 'strong-events';

import { Connection } from './Connection';
import { Serializer, getSerializer } from './serializer/Serializer';
import { Protocol, utf8Read, utf8Length } from './Protocol';

import { FossilDeltaSerializer } from './serializer/FossilDeltaSerializer';
import { Listener } from '@gamestdio/state-listener';
import { SchemaSerializer } from '.';
import { SchemaConstructor } from './serializer/SchemaSerializer';
import { Context, Schema } from '@colyseus/schema';

export interface RoomAvailable<Metadata> {
    roomId: string;
    clients: number;
    maxClients: number;
    metadata?: Metadata;
}

export class Room<State= any> {
    public id: string;
    public sessionId: string;

    public name: string;

    // Public signals
    public onJoin = createSignal();
    public onStateChange = createSignal<(state: State) => void>();
    public onMessage = createSignal<(data: any) => void>();
    public onError = createSignal<(message: string) => void>();
    public onLeave = createSignal<(code: number) => void>();

    public connection: Connection;

    public serializerId: string;
    protected serializer: Serializer<State>;

    protected hasJoined: boolean = false;
    protected previousCode: Protocol;

    // TODO: remove me on 1.0.0
    protected rootSchema: SchemaConstructor<State>;

    constructor(name: string, rootSchema?: SchemaConstructor<State>) {
        this.id = null;
        this.name = name;

        if (rootSchema) {
            this.serializer = new (getSerializer("schema"));
            this.rootSchema = rootSchema;
            (this.serializer as SchemaSerializer).state = new rootSchema();

        } else {
            // TODO: remove default serializer. it should arrive only after JOIN_ROOM.
            this.serializer = new (getSerializer("fossil-delta"));
        }

        this.onError((message) => console.error(message));
        this.onLeave(() => this.removeAllListeners());
    }

    public connect(endpoint: string) {
        this.connection = new Connection(endpoint, false);
        this.connection.reconnectEnabled = false;
        this.connection.onmessage = this.onMessageCallback.bind(this);
        this.connection.onclose = (e: CloseEvent) => {
            if (!this.hasJoined) {
                console.error(`Room connection was closed unexpectedly (${e.code}): ${e.reason}`);
                this.onError.invoke(e.reason);
                return;
            }

            this.onLeave.invoke(e.code)
        };
        this.connection.onerror = (e: CloseEvent) => {
            console.warn(`Room, onError (${e.code}): ${e.reason}`);
            this.onError.invoke(e.reason);
        };
        this.connection.open();
    }

    public leave(consented: boolean = true): void {
        if (this.connection) {
            if (consented) {
                this.connection.send([Protocol.LEAVE_ROOM]);

            } else {
                this.connection.close();
            }
        } else {
            this.onLeave.invoke(4000); // "consented" code
        }
    }

    public send(data): void {
        this.connection.send([Protocol.ROOM_DATA, data]);
    }

    public get state (): State {
        return this.serializer.getState();
    }

    // TODO: deprecate / move somewhere else
    // this method is useful only for FossilDeltaSerializer
    public listen(segments: string, callback: Function, immediate?: boolean) {
        if (this.serializerId === "schema") {
            console.error(`'${this.serializerId}' serializer doesn't support .listen() method.`);
            return;

        } else if (!this.serializerId) {
            console.warn("room.Listen() should be called after room.onJoin has been called (DEPRECATION WARNING)");
        }

        return (this.serializer as FossilDeltaSerializer<State>).api.listen(segments, callback, immediate);
    }

    // TODO: deprecate / move somewhere else
    // this method is useful only for FossilDeltaSerializer
    public removeListener(listener: Listener) {
        return (this.serializer as FossilDeltaSerializer<State>).api.removeListener(listener)
    }

    public removeAllListeners() {
        if (this.serializer) {
            this.serializer.teardown();
        }
        this.onJoin.clear();
        this.onStateChange.clear();
        this.onMessage.clear();
        this.onError.clear();
        this.onLeave.clear();
    }

    protected onMessageCallback(event: MessageEvent) {
        if (!this.previousCode) {
            const view = new DataView(event.data);
            const code = view.getUint8(0);

            if (code === Protocol.JOIN_ROOM) {
                let offset = 1;

                this.serializerId = utf8Read(view, offset);
                offset += utf8Length(this.serializerId);

                // get serializer implementation
                const serializer = getSerializer(this.serializerId);
                if (!serializer) {
                    throw new Error("missing serializer: " + this.serializerId);
                }

                // TODO: remove this check
                if (this.serializerId !== "fossil-delta" && !this.rootSchema) {
                    this.serializer = new serializer();
                }

                if (view.buffer.byteLength > offset && this.serializer.handshake) {
                    const bytes = Array.from(new Uint8Array(view.buffer.slice(offset)));
                    this.serializer.handshake(bytes);
                }

                this.hasJoined = true;
                this.onJoin.invoke();

            } else if (code === Protocol.JOIN_ERROR) {
                this.onError.invoke(utf8Read(view, 1));

            } else if (code === Protocol.LEAVE_ROOM) {
                this.leave();

            } else if (code === Protocol.ROOM_DATA_SCHEMA) {
                const bytes = Array.from(new Uint8Array(event.data))

                const context: Context = (this.serializer.getState() as any).constructor._context;
                const type = context.get(bytes[1]);

                const message: Schema = new (type as any)();
                message.decode(bytes, { offset: 2 });

                this.onMessage.invoke(message);

            } else {
                this.previousCode = code;
            }

        } else {
            if (this.previousCode === Protocol.ROOM_STATE) {
                // TODO: improve here!
                this.setState(Array.from(new Uint8Array(event.data)));

            } else if (this.previousCode === Protocol.ROOM_STATE_PATCH) {
                this.patch(Array.from(new Uint8Array(event.data)));

            } else if (this.previousCode === Protocol.ROOM_DATA) {
                this.onMessage.invoke(msgpack.decode(event.data));
            }

            this.previousCode = undefined;
        }
    }

    protected setState(encodedState): void {
        this.serializer.setState(encodedState);
        this.onStateChange.invoke(this.serializer.getState());
    }

    protected patch(binaryPatch) {
        this.serializer.patch(binaryPatch);
        this.onStateChange.invoke(this.serializer.getState());
    }

}
