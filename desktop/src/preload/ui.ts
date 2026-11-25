/**
 * The only bridge into the local UI: `window.cerea.call(channel, arg)` for the channels in
 * `shared/ipc.ts`, and `window.cerea.on(event, cb)` for what the main process pushes. The
 * renderer never sees ipcRenderer, and the Cerea window and the browser panel have no preload.
 */
import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS, EVENTS } from "../shared/ipc.ts";

contextBridge.exposeInMainWorld("cerea", {
	call: (channel: string, arg?: unknown): Promise<unknown> => {
		if (!(CHANNELS as string[]).includes(channel))
			return Promise.reject(new Error("unknown channel"));
		return ipcRenderer.invoke(channel, arg);
	},
	on: (event: string, cb: (data: unknown) => void): (() => void) => {
		if (!(EVENTS as readonly string[]).includes(event)) throw new Error("unknown event");
		const h = (_e: unknown, data: unknown) => cb(data);
		ipcRenderer.on(`ev:${event}`, h);
		return () => ipcRenderer.removeListener(`ev:${event}`, h);
	},
});
