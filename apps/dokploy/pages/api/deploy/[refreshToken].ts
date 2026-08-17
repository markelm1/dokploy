import {
	type Bitbucket,
	getBitbucketHeaders,
	IS_CLOUD,
	shouldDeploy,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { eq } from "drizzle-orm";
import type { NextApiRequest, NextApiResponse } from "next";
import { applications } from "@/server/db/schema";
import type { DeploymentJob } from "@/server/queues/queue-types";
import { myQueue } from "@/server/queues/queueSetup";
import { deploy } from "@/server/utils/deploy";

export const logWebhookError = (context: string, error: unknown) => {
	console.error(context, error);
};

const getPackageVersion = (headers: any, body: any) => {
	const event = headers["x-github-event"];
	if (event === "registry_package") {
		return body.registry_package?.package_version;
	}
	return null;
};

export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	const { refreshToken } = req.query;
	try {
		if (req.headers["x-github-event"] === "ping") {
			res.status(200).json({ message: "Ping received, webhook is active" });
			return;
		}
		const application = await db.query.applications.findFirst({
			where: eq(applications.refreshToken, refreshToken as string),
			with: {
				environment: {
					with: {
						project: true,
					},
				},
				bitbucket: true,
			},
		});

		if (!application) {
			res.status(404).json({ message: "Application Not Found" });
			return;
		}
		if (!application?.autoDeploy) {
			res.status(400).json({
				message: "Automatic deployments are disabled for this application",
			});
			return;
		}

		const deploymentTitle = extractCommitMessage(req.headers, req.body);
		const deploymentHash = extractHash(req.headers, req.body);
		const sourceType = application.sourceType;

		if (sourceType === "docker") {
			// ... docker handling unchanged ...
		} else if (sourceType === "github") {
			if (application.triggerType === "tag") {
				if (!isTagRef(req.headers, req.body)) {
					res.status(301).json({ message: "Trigger type is tag, but this is not a tag push" });
					return;
				}
			} else {
				const normalizedCommits = req.body?.commits?.flatMap((commit: any) => [
					...(commit.added || []),
					...(commit.modified || []),
					...(commit.removed || []),
				]);
				const shouldDeployPaths = shouldDeploy(
					application.watchPaths,
					normalizedCommits,
				);
				if (!shouldDeployPaths) {
					res.status(301).json({ message: "Watch Paths Not Match" });
					return;
				}
				const branchName = extractBranchName(req.headers, req.body);
				if (!branchName || branchName !== application.branch) {
					res.status(301).json({ message: "Branch Not Match" });
					return;
				}
			}
		} else if (sourceType === "git") {
			// ... git handling unchanged ...
		} else if (sourceType === "gitlab") {
			// ... gitlab handling unchanged ...
		} else if (sourceType === "bitbucket") {
			// ... bitbucket handling unchanged ...
		} else if (sourceType === "gitea") {
			if (application.triggerType === "tag") {
				if (!isTagRef(req.headers, req.body)) {
					res.status(301).json({ message: "Trigger type is tag, but this is not a tag push" });
					return;
				}
			} else {
				const branchName = extractBranchName(req.headers, req.body);
				const normalizedCommits = req.body?.commits?.flatMap((commit: any) => [
					...(commit.added || []),
					...(commit.modified || []),
					...(commit.removed || []),
				]);
				const shouldDeployPaths = shouldDeploy(
					application.watchPaths,
					normalizedCommits,
				);
				if (!shouldDeployPaths) {
					res.status(301).json({ message: "Watch Paths Not Match" });
					return;
				}
				if (!branchName || branchName !== application.giteaBranch) {
					res.status(301).json({ message: "Branch Not Match" });
					return;
				}
			}
		}

		try {
			const jobData: DeploymentJob = {
				applicationId: application.applicationId as string,
				titleLog: deploymentTitle,
				...(deploymentHash && { descriptionLog: `Hash: ${deploymentHash}` }),
				type: "deploy",
				applicationType: "application",
				server: !!application.serverId,
			};

			if (IS_CLOUD && application.serverId) {
				jobData.serverId = application.serverId;
				deploy(jobData).catch((error) => {
					console.error("Background deployment failed:", error);
				});
			} else {
				await myQueue.add(
					"deployments",
					{ ...jobData },
					{
						removeOnComplete: true,
						removeOnFail: true,
					},
				);
			}
		} catch (error) {
			logWebhookError("Error deploying Application:", error);
			res.status(400).json({ message: "Error deploying Application" });
			return;
		}

		res.status(200).json({ message: "Application deployed successfully" });
	} catch (error) {
		logWebhookError("Error deploying Application:", error);
		res.status(400).json({ message: "Error deploying Application" });
	}
}

export function extractImageName(dockerImage: string | null): string | null {
	if (!dockerImage || typeof dockerImage !== "string") return null;
	const lastColonIndex = dockerImage.lastIndexOf(":");
	if (lastColonIndex === -1) return dockerImage;
	const afterColon = dockerImage.substring(lastColonIndex + 1);
	const isPortNumber = /^\d{1,5}$/.test(afterColon);
	if (isPortNumber) return dockerImage;
	return dockerImage.substring(0, lastColonIndex);
}

export function extractImageTag(dockerImage: string | null) {
	if (!dockerImage || typeof dockerImage !== "string") return null;
	const lastColonIndex = dockerImage.lastIndexOf(":");
	if (lastColonIndex === -1) return "latest";
	const afterColon = dockerImage.substring(lastColonIndex + 1);
	const isPortWithPath = /^\d{1,5}\//.test(afterColon);
	if (isPortWithPath) return "latest";
	return afterColon;
}

export const extractImageNameFromRequest = (headers: any, body: any): string | null => {
	const packageVersion = getPackageVersion(headers, body);
	if (packageVersion?.package_url) {
		const packageUrl = packageVersion.package_url;
		if (packageUrl.includes(":")) {
			const lastColonIndex = packageUrl.lastIndexOf(":");
			const afterColon = packageUrl.substring(lastColonIndex + 1);
			const isPortNumber = /^\d{1,5}$/.test(afterColon);
			if (isPortNumber) return packageUrl;
			return packageUrl.substring(0, lastColonIndex);
		}
		return packageUrl;
	}
	if (headers["user-agent"]?.includes("Go-http-client")) {
		if (body.repository) return body.repository.repo_name;
	}
	return null;
};

export const extractImageTagFromRequest = (headers: any, body: any): string | null => {
	const packageVersion = getPackageVersion(headers, body);
	if (packageVersion) {
		const tagName = packageVersion.container_metadata?.tag?.name?.trim() || "";
		if (tagName && tagName !== packageVersion.version && !tagName.startsWith("sha256:")) return tagName;
		if (packageVersion.package_url) {
			const packageUrl = packageVersion.package_url;
			if (packageUrl.endsWith(":")) return null;
			const tagMatch = packageUrl.match(/:([^:]+)$/);
			if (tagMatch?.[1]?.trim()) return tagMatch[1].trim();
		}
	}
	if (headers["user-agent"]?.includes("Go-http-client")) {
		if (body.push_data && body.repository) return body.push_data.tag;
	}
	return null;
};

export const extractCommitMessage = (headers: any, body: any) => {
	const githubEvent = headers["x-github-event"];
	if (githubEvent === "registry_package") {
		const packageVersion = getPackageVersion(headers, body);
		if (packageVersion) {
			if (packageVersion.package_url) return `Docker GHCR image pushed: ${packageVersion.package_url}`;
			return "Docker GHCR image pushed";
		}
	}
	if (headers["x-github-event"]) return body.head_commit ? body.head_commit.message : "NEW COMMIT";
	if (headers["x-gitlab-event"]) return body.commits && body.commits.length > 0 ? body.commits[0].message : "NEW COMMIT";
	if (headers["x-event-key"]?.includes("repo:push")) return body.push.changes && body.push.changes.length > 0 ? body.push.changes[0].new.target.message : "NEW COMMIT";
	if (headers["x-gitea-event"]) return body.commits && body.commits.length > 0 ? body.commits[0].message : "NEW COMMIT";
	if (headers["x-softserve-event"]) return body.commits && body.commits.length > 0 ? body.commits[0].message : "NEW COMMIT";
	if (headers["user-agent"]?.includes("Go-http-client")) {
		if (body.push_data && body.repository) return `DockerHub image pushed: ${body.repository.repo_name}:${body.push_data.tag} by ${body.push_data.pusher}`;
	}
	return "NEW CHANGES";
};

export const extractHash = (headers: any, body: any) => {
	if (headers["x-github-event"]) return body.head_commit ? body.head_commit.id : "";
	if (headers["x-gitlab-event"]) return body.checkout_sha || (body.commits && body.commits.length > 0 ? body.commits[0].id : "NEW COMMIT");
	if (headers["x-event-key"]?.includes("repo:push")) return body.push.changes && body.push.changes.length > 0 ? body.push.changes[0].new.target.hash : "NEW COMMIT";
	if (headers["x-gitea-event"]) return body.after || "NEW COMMIT";
	if (headers["x-softserve-event"]) return body.after || "NEW COMMIT";
	return "";
};

export const extractBranchName = (headers: any, body: any) => {
	if (headers["x-github-event"] || headers["x-gitea-event"]) return body?.ref?.replace("refs/heads/", "");
	if (headers["x-gitlab-event"] || headers["x-softserve-event"]?.includes("push")) return body?.ref ? body?.ref.replace("refs/heads/", "") : null;
	if (headers["x-event-key"]?.includes("repo:push")) return body?.push?.changes[0]?.new?.name;
	return null;
};

export const extractTagName = (headers: any, body: any) => {
	if (headers["x-github-event"] || headers["x-gitea-event"]) return body?.ref?.replace("refs/tags/", "");
	return null;
};

export const isTagRef = (headers: any, body: any): boolean => {
	return body?.ref?.startsWith("refs/tags/") ?? false;
};

export const getProviderByHeader = (headers: any) => {
	if (headers["x-github-event"]) return "github";
	if (headers["x-gitea-event"]) return "gitea";
	if (headers["x-gitlab-event"]) return "gitlab";
	if (headers["x-event-key"]?.includes("repo:push")) return "bitbucket";
	if (headers["x-softserve-event"]) return "soft-serve";
	return null;
};

export const extractCommittedPaths = async (body: any, bitbucket: Bitbucket | null, repository: string) => {
	const changes = body.push?.changes || [];
	const commitHashes = changes.map((change: any) => change.new?.target?.hash).filter(Boolean);
	const committedPaths: string[] = [];
	const username = bitbucket?.bitbucketWorkspaceName || bitbucket?.bitbucketUsername || "";
	for (const commit of commitHashes) {
		const url = `https://api.bitbucket.org/2.0/repositories/${username}/${repository}/diffstat/${commit}`;
		try {
			const response = await fetch(url, { headers: getBitbucketHeaders(bitbucket!) });
			const data = await response.json();
			for (const value of data.values) {
				if (value?.new?.path) committedPaths.push(value.new.path);
			}
		} catch (error) {
			console.error(`Error fetching Bitbucket diffstat for commit ${commit}:`, error instanceof Error ? error.message : "Unknown error");
			return [];
		}
	}
	return committedPaths;
};