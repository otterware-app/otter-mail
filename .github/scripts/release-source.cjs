function repositoryDefaultBranch(context) {
  const branch = context.payload.repository?.default_branch;
  if (!branch) {
    throw new Error("GitHub did not provide the repository default branch.");
  }
  return branch;
}

function resolveReleaseChannel(context, dispatchChannel) {
  if (context.eventName === "workflow_dispatch") return dispatchChannel || "nightly";
  if (context.eventName === "push") {
    if (context.ref === `refs/heads/${repositoryDefaultBranch(context)}`) return "nightly";
    if (/^refs\/tags\/v\d+\.\d+\.\d+$/.test(context.ref)) return "stable";
  }
  throw new Error(`Unsupported release source: ${context.eventName} ${context.ref}`);
}

async function assertCommitOnDefaultBranch({ github, context, sha }) {
  const defaultBranch = repositoryDefaultBranch(context);
  const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
    ...context.repo,
    basehead: `${sha}...${defaultBranch}`,
    per_page: 1,
  });
  if (comparison.status !== "ahead" && comparison.status !== "identical") {
    throw new Error(
      `Release commit ${sha} is not contained in ${defaultBranch} (${comparison.status}).`,
    );
  }
}

async function assertReleaseSource({ github, context, releaseChannel }) {
  if (releaseChannel !== "stable" && releaseChannel !== "nightly") {
    throw new Error(`Unsupported release channel: ${releaseChannel}`);
  }

  const defaultBranch = repositoryDefaultBranch(context);
  if (context.eventName === "workflow_dispatch" && context.ref !== `refs/heads/${defaultBranch}`) {
    throw new Error(
      `${releaseChannel} releases must be dispatched from ${defaultBranch}; selected ${context.ref}.`,
    );
  }

  await assertCommitOnDefaultBranch({ github, context, sha: context.sha });
}

const isNightlyTag = (tag) => /^v\d+\.\d+\.\d+-nightly\.\d{8}\.[1-9]\d*$/.test(tag);

// Newest published nightly by publication time, or undefined when none exists.
async function findLatestNightly({ github, context }) {
  const releases = await github.paginate(github.rest.repos.listReleases, {
    ...context.repo,
    per_page: 100,
  });
  return releases
    .filter((release) => !release.draft && release.published_at && isNightlyTag(release.tag_name))
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
}

// Stable releases build the commit the latest nightly shipped, so the stable
// build is one nightly users already ran. Returns the nightly tag, its commit,
// and the stable version that nightly was a preview of.
async function resolveLatestNightlyCommit({ github, context, core }) {
  const lastNightly = await findLatestNightly({ github, context });
  if (!lastNightly) {
    throw new Error("No published nightly found. Stable releases build the latest nightly commit.");
  }

  const tag = lastNightly.tag_name;
  // repos.getCommit dereferences annotated tags, so this is the commit either way.
  const { data: commit } = await github.rest.repos.getCommit({ ...context.repo, ref: tag });
  const version = /^v(\d+\.\d+\.\d+)-nightly\./.exec(tag)?.[1];
  if (!version) {
    throw new Error(`Cannot derive a stable version from nightly tag ${tag}.`);
  }

  core.info(`Latest nightly ${tag} shipped ${commit.sha} as a preview of ${version}.`);
  return { tag, sha: commit.sha, version };
}

module.exports = {
  assertCommitOnDefaultBranch,
  assertReleaseSource,
  resolveReleaseChannel,
  resolveLatestNightlyCommit,
};
