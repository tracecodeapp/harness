import {
  createBrowserEventLoopApi,
} from "./event-loop";

export function createTimersPromisesApi(eventLoopApi: ReturnType<typeof createBrowserEventLoopApi>) {
  return {
    setTimeout: (delay?: number, value?: unknown) => new Promise((resolve) => {
      eventLoopApi.setTimeout(() => resolve(value), delay);
    }),
    setImmediate: (value?: unknown) => new Promise((resolve) => {
      eventLoopApi.setImmediate(() => resolve(value));
    }),
  };
}
