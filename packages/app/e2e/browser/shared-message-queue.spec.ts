import type { Page } from "@playwright/test";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, test } from "../support/fixtures";
import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import {
  attachImageFromMenu,
  expectAttachmentPill,
  fillComposerDraft,
  expectComposerVisible,
} from "../support/helpers/composer";

test("shared queue survives reload and synchronizes a second device with Vorton off/on", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "shared-queue-",
    title: "Shared queue acceptance",
    model: "thirty-minute-stream",
    initialPrompt: "Keep running while the shared queue is tested.",
  });
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "shared-queue" });
  let second: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    await client.mutateMessageQueue(agent.agentId, {
      kind: "pause",
      paused: true,
      operationId: "pause",
      expectedRevision: 0,
    });
    await openAgentRoute(page, agent);
    await expectComposerVisible(page);
    await page.evaluate(() => {
      const key = "@paseo:create-agent-preferences";
      localStorage.setItem(
        key,
        JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? "{}"), vortonMode: true }),
      );
    });
    await reloadPreservingPreferences(page);
    await expectComposerVisible(page);
    await page.evaluate(() => {
      const original = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data === "string") {
          const envelope = JSON.parse(data);
          if (envelope.message?.type === "agent.queue.mutate.request") {
            document.documentElement.dataset.queueRequestHeld = "true";
            return;
          }
        }
        original.call(this, data);
      };
    });
    // External dictation may populate the DOM without any keyboard event.
    await page
      .getByRole("textbox", { name: "Message agent..." })
      .first()
      .evaluate((element) => {
        const textarea = element as HTMLTextAreaElement;
        textarea.value = "Keep this through reload";
        textarea.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            inputType: "insertReplacementText",
            data: textarea.value,
          }),
        );
      });
    await expect(page.getByRole("button", { name: "Queue message", exact: true })).toBeEnabled();
    await attachImageFromMenu(page, {
      name: "queued-photo.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
      ),
    });
    await expectAttachmentPill(page, "composer-image-attachment-pill");
    await page.getByRole("button", { name: "Queue message", exact: true }).click();
    const queue = page.getByTestId("shared-message-queue");
    await expect(queue).toContainText("Keep this through reload");
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.queueRequestHeld))
      .toBe("true");
    await expect(queue).toContainText("Saved on this device");
    await expect(queue.getByTestId("queue-attachment-summary")).toHaveAttribute(
      "aria-label",
      "1 attachment",
    );
    expect((await client.readMessageQueue(agent.agentId)).snapshot?.items).toHaveLength(0);
    // Reload removes the interception and must recover the request from IndexedDB.
    await reloadPreservingPreferences(page);
    await expect(queue).toContainText("Keep this through reload");
    await expect
      .poll(async () => (await client.readMessageQueue(agent.agentId)).snapshot?.items.length)
      .toBe(1);

    second = await browser.newContext({
      baseURL: new URL(page.url()).origin,
      storageState: await page.context().storageState(),
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const other = await second.newPage();
    await openAgentRoute(other, agent);
    await expect(other.getByTestId("shared-message-queue")).toContainText(
      "Keep this through reload",
    );
    await expect(other.getByTestId("queue-attachment-summary")).toHaveAttribute(
      "aria-label",
      "1 attachment",
    );
    await fillComposerDraft(other, "From another device");
    await other.getByRole("button", { name: "Queue message", exact: true }).click();
    await expect(queue).toContainText("From another device");
    await expect
      .poll(async () => (await client.readMessageQueue(agent.agentId)).snapshot?.items.length)
      .toBe(2);
    await expect(queue.getByTestId("queue-attachment-summary")).toHaveCount(1);
    await expect(other.getByTestId("queue-attachment-summary")).toHaveCount(1);
    await test.info().attach("queue-desktop", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await test.info().attach("queue-touch", {
      body: await other.screenshot(),
      contentType: "image/png",
    });

    await page.evaluate(() => {
      const key = "@paseo:create-agent-preferences";
      localStorage.setItem(
        key,
        JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? "{}"), vortonMode: false }),
      );
    });
    await reloadPreservingPreferences(page);
    await expectComposerVisible(page);
    await expect(queue).toHaveCount(0);
    await test.info().attach("queue-vorton-off", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    expect((await client.readMessageQueue(agent.agentId)).snapshot?.items).toHaveLength(2);
    await expect(other.getByTestId("shared-message-queue")).toContainText("From another device");
  } catch (error) {
    console.error(
      "Queue acceptance page:",
      page.url(),
      await page
        .locator("body")
        .innerText()
        .catch(() => "Page unavailable"),
    );
    throw error;
  } finally {
    await second?.close();
    await client.close();
    await agent.cleanup();
  }
});

async function reloadPreservingPreferences(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.setItem(
      "@paseo:e2e-disable-default-seed-once",
      localStorage.getItem("@paseo:e2e-seed-nonce") ?? "",
    );
  });
  await page.reload({ waitUntil: "commit" });
}
