const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  assertReleaseSource,
  resolveReleaseChannel,
  resolveLatestNightlyCommit,
} = require("./release-source.cjs");

const nightly = {
  tag_name: "v0.13.10-nightly.20261013.123",
  draft: false,
  published_at: "2026-10-13T12:00:00Z",
};
function fixture(releases = [nightly], status = "ahead") {
  return {
    core: { info() {} },
    context: {
      repo: { owner: "otterware-app", repo: "otter-mail" },
      sha: "main-sha",
      ref: "refs/heads/main",
      eventName: "push",
      payload: { repository: { default_branch: "main" } },
    },
    github: {
      paginate: async () => releases,
      rest: {
        repos: {
          listReleases() {},
          compareCommitsWithBasehead: async () => ({ data: { status } }),
          getCommit: async ({ ref }) => {
            assert.equal(ref, nightly.tag_name);
            return { data: { sha: "nightly-sha" } };
          },
        },
      },
    },
  };
}

test("every main push selects nightly, stable tags and manual promotions select stable", () => {
  const { context } = fixture();
  assert.equal(resolveReleaseChannel(context), "nightly");
  assert.equal(resolveReleaseChannel({ ...context, ref: "refs/tags/v0.13.10" }), "stable");
  assert.equal(
    resolveReleaseChannel({ ...context, eventName: "workflow_dispatch" }, "stable"),
    "stable",
  );
  assert.equal(resolveReleaseChannel({ ...context, eventName: "workflow_dispatch" }), "nightly");
  for (const ref of [
    "refs/heads/feature",
    "refs/tags/v0.13.10-nightly.20261013.123",
    "refs/tags/ios-v0.6.9",
  ]) {
    assert.throws(() => resolveReleaseChannel({ ...context, ref }), /Unsupported release source/);
  }
});

test("stable promotes the newest published nightly, ignoring iPhone, stable and draft releases", async () => {
  const releases = [
    nightly,
    { ...nightly, tag_name: "ios-v0.9.0", published_at: "2026-10-13T19:00:00Z" },
    { ...nightly, tag_name: "v0.13.9", published_at: "2026-10-13T18:00:00Z" },
    { ...nightly, draft: true, published_at: "2026-10-13T17:00:00Z" },
  ];
  assert.deepEqual(await resolveLatestNightlyCommit(fixture(releases)), {
    tag: nightly.tag_name,
    sha: "nightly-sha",
    version: "0.13.10",
  });
  await assert.rejects(resolveLatestNightlyCommit(fixture([])), /No published nightly/);
});

test("releases must come from main, including stable tag targets", async () => {
  const f = fixture();
  await assertReleaseSource({ ...f, releaseChannel: "nightly" });
  await assert.rejects(
    assertReleaseSource({
      ...f,
      context: { ...f.context, eventName: "workflow_dispatch", ref: "refs/heads/feature" },
      releaseChannel: "stable",
    }),
    /must be dispatched from main/,
  );
  await assert.rejects(
    assertReleaseSource({ ...fixture([], "diverged"), releaseChannel: "stable" }),
    /not contained in main/,
  );
});
