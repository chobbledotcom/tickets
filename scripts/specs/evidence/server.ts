export interface LoopbackServer {
  baseUrl: string;
  close: () => Promise<void>;
}

export const defineLoopbackServer =
  (handler: Deno.ServeHandler<Deno.NetAddr>): (() => LoopbackServer) =>
  () => {
    const server = Deno.serve(
      { hostname: "127.0.0.1", onListen: () => {}, port: 0 },
      handler,
    );
    return {
      baseUrl: `http://127.0.0.1:${server.addr.port}`,
      close: async () => {
        await server.shutdown();
        await server.finished;
      },
    };
  };
