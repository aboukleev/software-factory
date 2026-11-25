// Knock's Feed client only creates its WebSocket connection in a browser
// runtime. Node 22 provides WebSocket, so expose its global object as `window`
// for this explicitly invoked live contract suite.
if (typeof window === "undefined") {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: globalThis,
    writable: true,
  });
}
