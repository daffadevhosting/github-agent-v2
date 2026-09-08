export class CollaborationRoom {
  private readonly sockets = new Set<WebSocket>();

  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.sockets.add(server);

    server.addEventListener("message", (event: MessageEvent) => {
      for (const socket of this.sockets) {
        if (socket !== server && socket.readyState === WebSocket.OPEN) {
          socket.send(String(event.data));
        }
      }
    });
    server.addEventListener("close", () => this.sockets.delete(server));
    server.addEventListener("error", () => this.sockets.delete(server));

    return new Response(null, {
      status: 101,
      webSocket: client,
    } as ResponseInit & { webSocket: WebSocket });
  }
}
