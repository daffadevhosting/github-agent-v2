interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

interface Ai {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface ExportedHandler<Environment = unknown> {
  fetch(request: Request, env: Environment, ctx: ExecutionContext): Promise<Response>;
}

declare module "cloudflare:workers" {
  interface TraceSpan {
    setAttribute(name: string, value: string | number | boolean): void;
  }

  export const tracing: {
    enterSpan<T>(
      name: string,
      callback: (span: TraceSpan) => Promise<T>
    ): Promise<T>;
  };
}
