import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";

async function switchUser(page: import("@playwright/test").Page, name: string) {
  const userButton = page.getByRole("button", {
    name: new RegExp(`^${name}`),
  });
  if (!(await userButton.isVisible())) {
    await page.getByRole("button", { name: "Switch user" }).click();
  }
  await userButton.click();
  const currentUser = page
    .getByText("Current user", { exact: true })
    .locator("xpath=following-sibling::div[1]");
  await expect(currentUser.getByText(name, { exact: true })).toBeVisible();
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
  await expect(item).toContainText(question);
  await item.click();

  await expect(page).toHaveURL(/#question-\d+$/);
  await expect(page.getByText(question)).toBeVisible();
  const questionTarget = page.locator(new URL(page.url()).hash);
  await expect(questionTarget).toBeFocused();
  await expect(questionTarget).toBeInViewport();
  await expect(questionTarget).toHaveAttribute(
    "data-notification-highlight",
    "true"
  );
  await expect(questionTarget).not.toHaveAttribute(
    "data-notification-highlight",
    "true",
    { timeout: 3_000 }
  );
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

test("an owning Instructor Reply reaches the Student and opens the exact Reply", async ({
  page,
}) => {
  await page.goto("/courses/introduction-to-typescript/lessons/1");
  await switchUser(page, "Emma Wilson");
  const question = `Can my Instructor answer this? ${Date.now()}`;
  const answer = `Instructor answer ${Date.now()}`;
  await page
    .getByPlaceholder("Ask a question or share what you found...")
    .fill(question);
  await page.getByRole("button", { name: "Post comment" }).click();
  await switchUser(page, "Sarah Chen");
  await page.goto("/instructor/questions");
  const questionCard = page
    .getByText(question)
    .locator("xpath=ancestor::*[.//textarea][1]");
  await questionCard.getByRole("textbox").fill(answer);
  await questionCard.getByRole("button", { name: "Post reply" }).click();

  await switchUser(page, "Emma Wilson");
  await page.goto("/courses/introduction-to-typescript/lessons/1");
  const postedQuestion = page.locator(`[id^="question-"]`, {
    hasText: question,
  });
  page.once("dialog", (dialog) => void dialog.accept());
  await postedQuestion.getByRole("button", { name: "Delete" }).click();
  await expect(
    page.getByText("This comment was deleted.").last()
  ).toBeVisible();
  await page
    .getByRole("button", { name: /Notification Feed, \d+ unread/ })
    .click();
  const replyNotification = page.getByRole("link", {
    name: /Your Instructor replied to your Question\./,
  });
  await expect(replyNotification).toContainText(answer);
  await replyNotification.click();
  await expect(page).toHaveURL(/#reply-\d+$/);
  const replyTarget = page.locator(new URL(page.url()).hash);
  await expect(replyTarget).toContainText(answer);
  await expect(replyTarget).toBeFocused();
  await expect(replyTarget).toBeInViewport();
  await expect(replyTarget).toHaveAttribute(
    "data-notification-highlight",
    "true"
  );
});

test("current edits produce safe previews and empty previews are omitted", async ({
  page,
}) => {
  await page.goto("/courses/introduction-to-typescript/lessons/1");
  await switchUser(page, "Emma Wilson");
  const initial = `Preview source ${Date.now()}`;
  const edited = `Edited **Question** with [useful label](https://secret.example/guide) ![private diagram](https://secret.example/image.png) raw https://secret.example/raw`;
  await page
    .getByPlaceholder("Ask a question or share what you found...")
    .fill(initial);
  await page.getByRole("button", { name: "Post comment" }).click();
  const question = page.locator(`[id^="question-"]`, { hasText: initial });
  const questionId = await question.getAttribute("id");
  expect(questionId).not.toBeNull();
  const questionTarget = page.locator(`#${questionId}`);
  await question.getByRole("button", { name: "Edit" }).click();
  await questionTarget.getByPlaceholder("Edit your comment").fill(edited);
  await questionTarget.getByRole("button", { name: "Save changes" }).click();
  await expect(questionTarget).toContainText(
    "Edited Question with useful label"
  );

  const emptySource = `![private](https://secret.example/image-${Date.now()}.png) https://secret.example/raw`;
  await page
    .getByPlaceholder("Ask a question or share what you found...")
    .fill(emptySource);
  await page.getByRole("button", { name: "Post comment" }).click();

  await switchUser(page, "Sarah Chen");
  await page
    .getByRole("button", { name: /Notification Feed, \d+ unread/ })
    .click();
  const feed = page.getByRole("region", { name: "Notification Feed" });
  const links = feed.getByRole("link", {
    name: /A Student asked a Question\./,
  });
  await expect(
    links.filter({ hasText: "Edited Question with useful label" })
  ).toHaveCount(1);
  await expect(feed.getByText(/secret\.example/)).toHaveCount(0);
  await expect(feed.getByText(/private diagram|private\]/)).toHaveCount(0);
});

test("lost Course authorization hides all resolved Notification context", async ({
  page,
}) => {
  await page.goto("/courses/introduction-to-typescript/lessons/1");
  await switchUser(page, "Emma Wilson");
  const question = `Private authorization context ${Date.now()}`;
  await page
    .getByPlaceholder("Ask a question or share what you found...")
    .fill(question);
  await page.getByRole("button", { name: "Post comment" }).click();

  const sqlite = new Database("data.db");
  const course = sqlite
    .prepare(
      "select id, instructor_id as instructorId from courses where slug = ?"
    )
    .get("introduction-to-typescript") as {
    id: number;
    instructorId: number;
  };
  const replacement = sqlite
    .prepare(
      "select id from users where role = 'instructor' and id <> ? order by id limit 1"
    )
    .get(course.instructorId) as { id: number };

  try {
    sqlite
      .prepare("update courses set instructor_id = ? where id = ?")
      .run(replacement.id, course.id);
    await switchUser(page, "Sarah Chen");
    await page
      .getByRole("button", { name: /Notification Feed, \d+ unread/ })
      .click();
    const feed = page.getByRole("region", { name: "Notification Feed" });
    const unavailable = feed
      .locator('a[href="/notifications/unavailable"]')
      .first();
    await expect(unavailable).toContainText("Conversation no longer available");
    await expect(unavailable).not.toContainText(question);
    await expect(unavailable).not.toContainText("Introduction to TypeScript");
  } finally {
    sqlite
      .prepare("update courses set instructor_id = ? where id = ?")
      .run(course.instructorId, course.id);
    sqlite.close();
  }
});

test("a Platform Admin Reply uses Platform Admin wording for the Student", async ({
  page,
}) => {
  await page.goto("/courses/introduction-to-typescript/lessons/1");
  await switchUser(page, "Olivia Martinez");
  const question = `Can Cadence answer this? ${Date.now()}`;
  const answer = `Platform answer ${Date.now()}`;
  await page
    .getByPlaceholder("Ask a question or share what you found...")
    .fill(question);
  await page.getByRole("button", { name: "Post comment" }).click();
  await switchUser(page, "Alex Rivera");
  await page.goto("/instructor/questions");
  const questionCard = page
    .getByText(question)
    .locator("xpath=ancestor::*[.//textarea][1]");
  await questionCard.getByRole("textbox").fill(answer);
  await questionCard.getByRole("button", { name: "Post reply" }).click();

  await switchUser(page, "Olivia Martinez");
  await page
    .getByRole("button", { name: /Notification Feed, \d+ unread/ })
    .click();
  await page
    .getByRole("link", {
      name: /A Platform Admin replied to your Question\./,
    })
    .click();
  await expect(page).toHaveURL(/#reply-\d+$/);
  await expect(page.locator(new URL(page.url()).hash)).toContainText(answer);
});

test("the full Feed pages provider order, refreshes time, and retains stale content", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/courses/introduction-to-typescript/lessons/1");
  await switchUser(page, "Emma Wilson");

  const questionPrefix = `Pagination ${Date.now()}`;
  const longQuestion = `${questionPrefix} item 21 ${"long-content ".repeat(120)}`;
  for (let index = 1; index <= 21; index += 1) {
    const question =
      index === 21 ? longQuestion : `${questionPrefix} item ${index}`;
    const response = await page.request.post(
      "/courses/introduction-to-typescript/lessons/1",
      { form: { intent: "create-comment", body: question } }
    );
    expect(response.ok()).toBe(true);
  }

  await switchUser(page, "Sarah Chen");
  await page.goto("/notifications");
  const feed = page.getByRole("region", { name: "Notification Feed" });
  const items = feed.getByRole("link", {
    name: /A Student asked a Question\./,
  });

  await expect(items).toHaveCount(20);
  const newestTime = items.first().locator("time");
  await expect(newestTime).toHaveText(/just now/);
  await expect(newestTime).toHaveAttribute("dateTime", /T/);
  await expect(newestTime).toHaveAttribute("title", /\d/);

  await page.clock.setFixedTime(Date.now() + 121_000);
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange"))
  );
  await expect(newestTime).toHaveText(/2 minutes ago/);

  const loadMore = feed.getByRole("button", { name: "Load more" });
  await loadMore.focus();
  await loadMore.click();
  await expect.poll(() => items.count()).toBeGreaterThan(20);
  const loadedItemCount = await items.count();
  await expect(loadMore).toHaveCount(0);
  await expect(items.nth(20)).toBeFocused();

  await expect(feed.getByRole("button", { name: /mark unread/i })).toHaveCount(
    0
  );
  await expect(feed.getByRole("button", { name: /archive/i })).toHaveCount(0);
  await expect(feed.getByRole("button", { name: /delete/i })).toHaveCount(0);

  await page.route("**/notifications/feed*", async (route) => {
    await route.fulfill({ status: 503, body: "temporarily unavailable" });
  });
  await feed.getByRole("button", { name: "Mark all read" }).click();
  await expect(
    feed.getByText(/temporarily out of date.*Course activity is unaffected/i)
  ).toBeVisible();
  await expect(items).toHaveCount(loadedItemCount);

  await page.unroute("**/notifications/feed*");
  await feed.getByRole("button", { name: "Retry Feed" }).click();
  await expect(feed.getByText(/temporarily out of date/i)).toHaveCount(0);
  await expect(feed.getByText("0 unread")).toBeVisible();

  // The provider's newest item remains first after pagination and refresh. Its
  // long source content can still be reached without being copied into Knock.
  await items.first().click();
  await expect(page.getByText(longQuestion, { exact: true })).toBeVisible();
});
