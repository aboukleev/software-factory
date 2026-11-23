import { expect, test } from "@playwright/test";

async function switchUser(page: import("@playwright/test").Page, name: string) {
  const userButton = page.getByRole("button", {
    name: new RegExp(`^${name}`),
  });
  if (!(await userButton.isVisible())) {
    await page.getByRole("button", { name: "Switch user" }).click();
  }
  await userButton.click();
  await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
}

test("an enrolled Student Question reaches the owning Instructor", async ({
  page,
}) => {
  await page.goto("/courses/introduction-to-typescript/lessons/1");
  await switchUser(page, "Emma Wilson");

  const question = `How does the notification tracer work? ${Date.now()}`;
  await page
    .getByPlaceholder("Ask a question or share what you found...")
    .fill(question);
  await page.getByRole("button", { name: "Post comment" }).click();
  await expect(page.getByText(question)).toBeVisible();

  await switchUser(page, "Sarah Chen");
  const bell = page.getByRole("button", {
    name: /Notification Feed, 1 unread/,
  });
  await expect(bell).toBeVisible();
  await bell.click();

  const feed = page.getByRole("region", { name: "Notification Feed" });
  await expect(feed.getByText("1 unread")).toBeVisible();
  const item = feed.getByRole("link", {
    name: /A Student asked a Question\./,
  });
  await expect(item).toBeVisible();
  await item.click();

  await expect(page).toHaveURL(/#question-\d+$/);
  await expect(page.getByText(question)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Notification Feed", exact: true })
  ).toBeVisible();
});

test("explicit reads reconcile failures without blocking navigation", async ({
  page,
}) => {
  await page.goto("/courses/introduction-to-typescript/lessons/1");
  await switchUser(page, "Emma Wilson");
  const question = `Read semantics ${Date.now()}`;
  await page
    .getByPlaceholder("Ask a question or share what you found...")
    .fill(question);
  await page.getByRole("button", { name: "Post comment" }).click();
  await expect(page.getByText(question)).toBeVisible();

  await switchUser(page, "Sarah Chen");
  await expect(
    page.getByRole("button", { name: /Notification Feed, 1 unread/ })
  ).toBeVisible();
  await page.reload();
  const bell = page.getByRole("button", {
    name: /Notification Feed, 1 unread/,
  });
  await bell.click();
  const feed = page.getByRole("region", { name: "Notification Feed" });
  await expect(feed.getByText("1 unread")).toBeVisible();
  await bell.click();
  await bell.click();
  await expect(feed.getByText("1 unread")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(feed).toHaveCSS("position", "fixed");
  await page.setViewportSize({ width: 1280, height: 800 });
  await feed.getByRole("link", { name: "Open full Notification Feed" }).click();
  await expect(page).toHaveURL(/\/notifications$/);
  const fullFeed = page.getByRole("region", { name: "Notification Feed" });
  await expect(fullFeed.getByText("1 unread")).toBeVisible();

  await page.route("**/notifications/read", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: '{"ok":false}',
    });
  });
  await fullFeed
    .getByRole("link", { name: /Unread\. A Student asked/ })
    .click();
  await expect(page).toHaveURL(/#question-\d+$/);
  await expect(page.getByText(question)).toBeVisible();
  await expect(page.getByText(/could not mark/i)).toHaveCount(0);
  await page.waitForLoadState("networkidle");

  const reopenedFeed = page.getByRole("region", { name: "Notification Feed" });
  if (!(await reopenedFeed.isVisible())) {
    await page
      .getByRole("button", { name: /Notification Feed, 1 unread/ })
      .click();
  }
  await expect(reopenedFeed).toBeVisible();
  await reopenedFeed.getByRole("button", { name: "Mark all read" }).click();
  await expect(reopenedFeed.getByText("1 unread")).toBeVisible();
  await expect(
    reopenedFeed.getByRole("button", { name: "Retry" })
  ).toBeVisible();

  await page.unroute("**/notifications/read");
  await reopenedFeed.getByRole("button", { name: "Retry" }).click();
  await expect(reopenedFeed.getByText("0 unread")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Notification Feed", exact: true })
  ).toBeVisible();

  await page.goto("/notifications/unavailable");
  await expect(
    page.getByRole("heading", { name: "Conversation unavailable" })
  ).toBeVisible();
});
