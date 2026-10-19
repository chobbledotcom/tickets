  describe("image urls for references", () => {
    test("answers an overlong img# reference with no image", async () => {
      // A 400-digit id overflows to Infinity, which no binder accepts.
      const urls = await imageUrlsFor([`![Poster](img#${"9".repeat(400)})`]);

      expect(urls.size).toBe(0);
    });
  });

  describe("the footer's image table", () => {
    test("does nothing outside a request", async () => {
      // The footer names an image, so a missing request guard would run the
      // lookup; the recording must stay empty.
      await settings.update.siteFooter("![Outside](img#1)");
      const db = getDb();
      const realExecute = db.execute.bind(db);
      const ran: string[] = [];
      const executeStub = stub(db, "execute", (stmt: InStatement) => {
        ran.push(typeof stmt === "string" ? stmt : stmt.sql);
        return realExecute(stmt);
      });
      try {
        await addFooterImageUrls();
      } finally {
        executeStub.restore();
      }
      expect(ran).toEqual([]);
