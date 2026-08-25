import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { mailConfig, sendMail, deliver, DEFAULT_FROM, type MailConfig } from "./mail.js";

/**
 * Real requests over real HTTP to a server this file controls — the technique
 * `stripe-live.test.ts` uses, and for the same reason. A stub that agrees with
 * whatever it is handed proves the code calls itself correctly and nothing
 * about the request that leaves the process.
 *
 * What is worth checking here is small and specific: the auth header, the body
 * shape a provider will actually parse, and that no failure path puts the API
 * key or the credential we just minted anywhere a log can see them.
 */

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  contentType: string | undefined;
  body: string;
}

let server: Server;
let base: string;
const seen: Seen[] = [];
let reply: { status: number; body: string } = { status: 200, body: '{"id":"re_123"}' };

function read(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

before(async () => {
  server = createServer(async (req, res) => {
    seen.push({
      method: req.method ?? "",
      url: req.url ?? "",
      auth: req.headers.authorization,
      contentType: req.headers["content-type"],
      body: await read(req),
    });
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(reply.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

const config = (): MailConfig => ({ apiKey: "re_NEVERLOGTHIS", from: "a@b.test", apiBase: base });
const last = () => seen[seen.length - 1]!;

describe("what actually leaves the process", () => {
  test("a send is a POST to /emails with the key in the header", async () => {
    reply = { status: 200, body: '{"id":"re_abc"}' };
    const result = await sendMail({ to: "you@example.com", subject: "S", text: "T" }, config());

    assert.deepEqual(result, { ok: true, id: "re_abc" });
    assert.equal(last().method, "POST");
    assert.equal(last().url, "/emails");
    assert.equal(last().auth, "Bearer re_NEVERLOGTHIS");
    assert.match(last().contentType ?? "", /application\/json/);
  });

  test("the body carries the fields a provider parses, and `to` is a list", async () => {
    reply = { status: 200, body: '{"id":"re_abc"}' };
    await sendMail({ to: "you@example.com", subject: "Your full audit", text: "link" }, config());

    const body = JSON.parse(last().body) as Record<string, unknown>;
    assert.equal(body.from, "a@b.test");
    assert.deepEqual(body.to, ["you@example.com"], "Resend takes an array, not a string");
    assert.equal(body.subject, "Your full audit");
    assert.equal(body.text, "link");
  });

  test("a rejection is reported, and never as an exception", async () => {
    // The visitor has already been told a link is coming. A throw here would
    // turn a mail problem into a page error about an audit that is fine.
    reply = { status: 422, body: '{"message":"domain is not verified"}' };
    const result = await sendMail({ to: "you@example.com", subject: "S", text: "T" }, config());

    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error : "", /422/);
    assert.match(result.ok === false ? result.error : "", /domain is not verified/);
  });

  test("no failure carries the key or the credential", async () => {
    /**
     * The one that matters. The error text is logged, and the two things that
     * must never reach a log are the API key — which is in a header on every
     * request — and the magic link in the body, which is a bearer credential
     * for someone's audit.
     */
    reply = { status: 500, body: "upstream exploded" };
    const secret = "https://example.com/a/x/full?t=SECRET-TOKEN";
    const result = await sendMail(
      { to: "you@example.com", subject: "S", text: secret },
      config(),
    );

    assert.equal(result.ok, false);
    const error = result.ok === false ? result.error : "";
    assert.ok(!error.includes("re_NEVERLOGTHIS"), "the key must not be in the error");
    assert.ok(!error.includes("SECRET-TOKEN"), "nor the credential we just minted");
  });

  test("an unreachable provider is an error, not a crash", async () => {
    const result = await sendMail(
      { to: "you@example.com", subject: "S", text: "T" },
      { apiKey: "k", from: "a@b.test", apiBase: "http://127.0.0.1:1" },
    );
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error : "", /transport failed/);
  });

  test("a 200 in a shape we do not recognise is still a send", async () => {
    // The provider took it. Reporting failure would invite a resend of mail
    // that already went out.
    reply = { status: 200, body: "not json" };
    const result = await sendMail({ to: "you@example.com", subject: "S", text: "T" }, config());
    assert.equal(result.ok, true);
  });
});

describe("what happens with no account at all", () => {
  test("no key means print, and nothing is sent", async () => {
    const before = seen.length;
    const result = await deliver({ to: "you@example.com", subject: "S", text: "link" }, null);

    assert.deepEqual(result, { ok: true, id: "console" });
    assert.equal(seen.length, before, "no request left the process");
  });

  test("config is null without a key, so a fresh clone prints rather than fails", () => {
    assert.equal(mailConfig({}), null);
    assert.equal(mailConfig({ RESEND_API_KEY: "   " }), null);
  });

  test("an unverified account can still send from Resend's own address", () => {
    // Before any DNS exists, this is the only `from` that works — which is why
    // it is the default rather than a configuration error.
    assert.equal(mailConfig({ RESEND_API_KEY: "k" })?.from, DEFAULT_FROM);
    assert.equal(
      mailConfig({ RESEND_API_KEY: "k", USABILITY_LAB_MAIL_FROM: "hi@lab.test" })?.from,
      "hi@lab.test",
    );
  });
});
