/**
 * Who may see a project.
 *
 * This gets its own tests because the shape is one a plausible implementation
 * gets wrong in a way that no ordinary use reveals: the gateway's equivalent
 * ACL shipped with `or` where `and` belonged, which made every shared resource
 * readable by everybody the moment it was shared with anybody, and fourteen
 * existing tests passed against it. The test that catches that class of bug is
 * the third party — somebody who is neither the owner nor the person it was
 * shared with — so there is one here for each way a share can be written.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { projectAccess, listProjects, type ViewerPrincipals } from "$lib/server/projects";
import type { Project, ProjectShare } from "$lib/types/Project";

beforeAll(async () => {
	await ready;
}, 30000);

beforeEach(async () => {
	await collections.projects.deleteMany({});
}, 20000);

async function makeProject(
	owner: ObjectId,
	shares: ProjectShare[] = [],
	name = "A project"
): Promise<Project> {
	const now = new Date();
	const project: Project = {
		_id: new ObjectId(),
		userId: owner,
		name,
		description: "",
		instructions: "",
		knowledgeBaseIds: [],
		indexPastChats: false,
		retrievalLimit: 6,
		shares,
		createdAt: now,
		updatedAt: now,
	};
	await collections.projects.insertOne(project);
	return project;
}

const nobody: ViewerPrincipals = { groups: [] };

function asUser(email: string, groups: string[] = []): ViewerPrincipals {
	return { email, groups };
}

describe("projectAccess", () => {
	it("gives the owner their own project, marked owned", async () => {
		const owner = new ObjectId();
		const project = await makeProject(owner);

		const access = await projectAccess(project._id.toString(), owner, nobody);

		expect(access?.owned).toBe(true);
		expect(access?.project._id.equals(project._id)).toBe(true);
	});

	it("refuses a stranger a project shared with nobody", async () => {
		const project = await makeProject(new ObjectId());

		expect(
			await projectAccess(project._id.toString(), new ObjectId(), asUser("stranger@example.org"))
		).toBeNull();
	});

	it("admits the person a project was shared with by address", async () => {
		const project = await makeProject(new ObjectId(), [
			{ kind: "user", email: "colleague@example.org", createdAt: new Date() },
		]);

		const access = await projectAccess(
			project._id.toString(),
			new ObjectId(),
			asUser("colleague@example.org")
		);

		expect(access).not.toBeNull();
		// Not the owner: they may chat in it and may not change it.
		expect(access?.owned).toBe(false);
	});

	it("refuses a third party a project shared with somebody else", async () => {
		// The bug this exists for. An implementation that asks "is this project
		// shared with anyone" rather than "is it shared with *you*" passes every
		// other test in this file.
		const project = await makeProject(new ObjectId(), [
			{ kind: "user", email: "colleague@example.org", createdAt: new Date() },
		]);

		expect(
			await projectAccess(project._id.toString(), new ObjectId(), asUser("someone@example.org"))
		).toBeNull();
	});

	it("admits a member of a group it was shared with", async () => {
		const project = await makeProject(new ObjectId(), [
			{ kind: "group", name: "research", createdAt: new Date() },
		]);

		const access = await projectAccess(
			project._id.toString(),
			new ObjectId(),
			asUser("member@example.org", ["research"])
		);

		expect(access?.owned).toBe(false);
	});

	it("refuses somebody in a different group", async () => {
		const project = await makeProject(new ObjectId(), [
			{ kind: "group", name: "research", createdAt: new Date() },
		]);

		expect(
			await projectAccess(
				project._id.toString(),
				new ObjectId(),
				asUser("member@example.org", ["finance"])
			)
		).toBeNull();
	});

	it("refuses a viewer with no address when the share names one", async () => {
		// An anonymous or address-less session must not match a share. The
		// dangerous version of this compares `undefined === undefined` and lets
		// everybody in through a share written to an account with no email.
		const project = await makeProject(new ObjectId(), [
			{ kind: "user", email: "colleague@example.org", createdAt: new Date() },
		]);

		expect(await projectAccess(project._id.toString(), new ObjectId(), nobody)).toBeNull();
	});

	it("returns null for a malformed id rather than throwing", async () => {
		// The id comes from a URL. `new ObjectId("nonsense")` throws, and a 500
		// on a mistyped link is worse than a 404.
		expect(await projectAccess("not-an-object-id", new ObjectId(), nobody)).toBeNull();
	});
});

describe("listProjects", () => {
	it("lists what somebody owns and what was given to them, and nothing else", async () => {
		const me = new ObjectId();
		const someoneElse = new ObjectId();

		const mine = await makeProject(me, [], "Mine");
		const sharedWithMe = await makeProject(
			someoneElse,
			[{ kind: "user", email: "me@example.org", createdAt: new Date() }],
			"Shared with me"
		);
		const sharedWithMyGroup = await makeProject(
			someoneElse,
			[{ kind: "group", name: "research", createdAt: new Date() }],
			"Shared with my group"
		);
		await makeProject(someoneElse, [], "Not mine");
		await makeProject(
			someoneElse,
			[{ kind: "user", email: "third@example.org", createdAt: new Date() }],
			"Shared with a third party"
		);

		const listed = await listProjects(me, asUser("me@example.org", ["research"]));
		const ids = listed.map((project) => project._id.toString()).sort();

		expect(ids).toEqual(
			[mine._id.toString(), sharedWithMe._id.toString(), sharedWithMyGroup._id.toString()].sort()
		);
	});

	it("lists nothing for somebody with no projects and no shares", async () => {
		await makeProject(new ObjectId(), [
			{ kind: "user", email: "colleague@example.org", createdAt: new Date() },
		]);

		expect(await listProjects(new ObjectId(), asUser("nobody@example.org"))).toEqual([]);
	});
});
