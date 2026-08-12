/** A response whose body stream fails with the supplied transport error. */
export const unreadableResponse = (error: unknown, status = 200): Response =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.error(error);
      },
    }),
    { status },
  );
