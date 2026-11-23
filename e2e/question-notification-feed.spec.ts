import { expect, test } from "@playwright/test";

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
  const item = feed.getByRole("button", {
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
  await expect(page.getByText(question)).toBeVisible();

  await switchUser(page, "Sarah Chen");
  await page.goto("/instructor/questions");
  const questionCard = page
    .getByText(question)
    .locator("xpath=ancestor::*[.//textarea][1]");
  await questionCard.getByRole("textbox").fill(answer);
  await questionCard.getByRole("button", { name: "Post reply" }).click();
  await expect(page.getByText(question)).toHaveCount(0);

  await switchUser(page, "Emma Wilson");
  const bell = page.getByRole("button", {
    name: /Notification Feed, \d+ unread/,
  });
  await bell.click();
  const item = page.getByRole("button", {
    name: /Your Instructor replied to your Question\./,
  });
  await expect(item).toBeVisible();
  await item.click();

  await expect(page).toHaveURL(/#reply-\d+$/);
  await expect(page.getByText(answer)).toBeVisible();
  await expect(page.locator(new URL(page.url()).hash)).toContainText(answer);
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
  await expect(page.getByText(question)).toBeVisible();

  await switchUser(page, "Alex Rivera");
  await page.goto("/instructor/questions");
  const questionCard = page
    .getByText(question)
    .locator("xpath=ancestor::*[.//textarea][1]");
  await questionCard.getByRole("textbox").fill(answer);
  await questionCard.getByRole("button", { name: "Post reply" }).click();
  await expect(page.getByText(question)).toHaveCount(0);

  await switchUser(page, "Olivia Martinez");
  await page
    .getByRole("button", { name: /Notification Feed, \d+ unread/ })
    .click();
  const item = page.getByRole("button", {
    name: /A Platform Admin replied to your Question\./,
  });
  await expect(item).toBeVisible();
  await item.click();
  await expect(page).toHaveURL(/#reply-\d+$/);
  await expect(page.locator(new URL(page.url()).hash)).toContainText(answer);
});
