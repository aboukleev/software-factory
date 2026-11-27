import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

async function switchUser(page: import("@playwright/test").Page, name: string) {
  const userButton = page.getByRole("button", {
    name: new RegExp(`^${name}`),
  });
  if (!(await userButton.isVisible())) {
    await page.getByRole("button", { name: "Switch user" }).click();
  }
  await userButton.click();
  await expect(
    page
      .getByText("Current user", { exact: true })
      .locator("xpath=following-sibling::div[1]")
      .getByText(name, { exact: true })
  ).toBeVisible();
}

test("the quick Notification Feed is modal, responsive, and accessible", async ({
  page,
}, testInfo) => {
  await page.goto("/courses/introduction-to-typescript/lessons/1");
  await switchUser(page, "Sarah Chen");
  const preview = `Accessible Feed item ${Date.now()}`;
  const occurredAt = new Date().toISOString();
  await page.route("**/notifications/feed*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          {
            id: `accessible-${testInfo.project.name}`,
            readAt: null,
            occurredAt,
            eventKind: "question.created",
            actorCapacity: "student",
            availability: "available",
            courseTitle: "Introduction to TypeScript",
            lessonTitle: "What is TypeScript?",
            preview,
            destinationUrl: "/notifications/unavailable",
            destinationAvailable: true,
          },
        ],
        unreadCount: 1,
        nextCursor: null,
      }),
    })
  );
  const bell = page.getByRole("button", {
    name: /^Notification Feed(?:, \d+ unread)?$/,
  });
  await expect(bell).toBeVisible();
  await expect(bell).toHaveAttribute("aria-expanded", "false");
  await bell.click();

  const dialog = page.getByRole("dialog", { name: "Notification Feed" });
  const feed = dialog.getByRole("region", { name: "Notification Feed" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(
    feed.getByRole("heading", { name: "Notification Feed" })
  ).toBeFocused();
  await expect(bell).toHaveAttribute("aria-expanded", "true");

  const item = feed.getByRole("link", {
    name: new RegExp(
      `Unread\\. A Student asked a Question\\. Introduction to TypeScript · What is TypeScript\\? ${preview} .+\\d`
    ),
  });
  await expect(item).toBeVisible();
  await expect(item.locator("time")).toHaveAttribute("dateTime", /T/);
  await expect(item.locator("time")).toHaveAttribute("title", /\d/);

  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  if (!box) throw new Error("Notification Feed has no bounding box");
  if (testInfo.project.name === "narrow-chrome") {
    expect(box).toEqual({ x: 0, y: 0, width: 390, height: 844 });
  } else {
    expect(box.width).toBeLessThanOrEqual(384);
    expect(box.height).toBeLessThan(800);
  }

  const close = dialog.getByRole("button", { name: "Close Notification Feed" });
  for (const control of [bell, close]) {
    const controlBox = await control.boundingBox();
    if (!controlBox)
      throw new Error("Notification control has no bounding box");
    expect(controlBox.width).toBeGreaterThanOrEqual(44);
    expect(controlBox.height).toBeGreaterThanOrEqual(44);
  }

  await page.keyboard.press("Shift+Tab");
  await expect(dialog).toContainText("Notification Feed");
  expect(
    await dialog.evaluate((node) => node.contains(document.activeElement))
  ).toBe(true);

  const accessibility = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .analyze();
  expect(
    accessibility.violations.filter(
      ({ impact }) => impact === "serious" || impact === "critical"
    )
  ).toEqual([]);

  await page.emulateMedia({ reducedMotion: "reduce", forcedColors: "active" });
  await expect(close).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(bell).toBeFocused();
});

test("opening the full Notification Feed transfers focus coherently", async ({
  page,
}) => {
  await page.goto("/courses/introduction-to-typescript/lessons/1");
  await switchUser(page, "Sarah Chen");
  const bell = page.getByRole("button", { name: /Notification Feed/ });
  await bell.click();
  const dialog = page.getByRole("dialog", { name: "Notification Feed" });
  await dialog
    .getByRole("link", { name: "Open full Notification Feed" })
    .click();

  await expect(page).toHaveURL(/\/notifications$/);
  await expect(dialog).toHaveCount(0);
  const feed = page.getByRole("region", { name: "Notification Feed" });
  await expect(
    feed.getByRole("heading", { name: "Notification Feed" })
  ).toBeFocused();
  const accessibility = await new AxeBuilder({ page })
    .include('[aria-label="Notification Feed"]')
    .analyze();
  expect(
    accessibility.violations.filter(
      ({ impact }) => impact === "serious" || impact === "critical"
    )
  ).toEqual([]);
});
