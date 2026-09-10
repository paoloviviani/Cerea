/**
 * Who a project is shared with.
 *
 * A share names a principal rather than resolving one: an email address, or a
 * group name. Nothing here asks the gateway "does this person exist" or "who
 * is in this group", because a bearer token cannot ask — `/v1/billing/groups`
 * reports the caller's own memberships and no more (ADR 0061), and a route that
 * could answer for anyone else would let a chat client enumerate the
 * deployment's directory.
 *
 * The consequence is stated on the page, not hidden: a typo'd address and a
 * colleague who has not signed in yet look identical, and both stay pending
 * until somebody with that address opens the project. Access is decided when
 * they do, against their own token.
 *
 * A group name is *not* validated against the owner's own groups either. An
 * owner may legitimately share into a group they are not in — a project for a
 * team they support — and refusing that would be a rule invented here rather
 * than one the deployment asked for.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { collections } from "$lib/server/database";
import { projectAccess, projectView, viewerPrincipals } from "$lib/server/projects";
import type { ProjectShare } from "$lib/types/Project";

const body = z.union([
	z.object({ kind: z.literal("user"), email: z.string().trim().email().max(320) }),
	z.object({ kind: z.literal("group"), name: z.string().trim().min(1).max(128) }),
]);

function requireUser(locals: App.Locals) {
	if (!locals.user) error(401, "Login required");
	return locals.user;
}

async function ownedProject(locals: App.Locals, id: string) {
	const user = requireUser(locals);
	const principals = await viewerPrincipals(user, locals.token);
	const access = await projectAccess(id, user._id, principals);
	if (!access) error(404, "No such project.");
	if (!access.owned) error(403, "Only the person who created a project can share it.");
	return access;
}

export const POST: RequestHandler = async ({ locals, params, request }) => {
	const access = await ownedProject(locals, params.id as string);
	const parsed = body.safeParse(await request.json());
	if (!parsed.success) {
		error(400, "Give either an email address or a group name.");
	}

	// Lower-cased on the way in, because it is compared against the viewer's
	// own address at read time and an address that differs only in case is the
	// same address. Group names are not folded: they are the directory's
	// strings and the gateway compares them exactly.
	const share: ProjectShare =
		parsed.data.kind === "user"
			? { kind: "user", email: parsed.data.email.toLowerCase(), createdAt: new Date() }
			: { kind: "group", name: parsed.data.name, createdAt: new Date() };

	const principal = share.kind === "user" ? share.email : share.name;
	const already = access.project.shares.some(
		(existing) =>
			existing.kind === share.kind &&
			(existing.kind === "user" ? existing.email : existing.name) === principal
	);
	if (!already) {
		await collections.projects.updateOne(
			{ _id: access.project._id },
			{ $push: { shares: share }, $set: { updatedAt: new Date() } }
		);
		access.project.shares.push(share);
	}
	return json(await projectView(access));
};

export const DELETE: RequestHandler = async ({ locals, params, url }) => {
	const access = await ownedProject(locals, params.id as string);
	const kind = url.searchParams.get("kind");
	const principal = url.searchParams.get("principal");
	if ((kind !== "user" && kind !== "group") || !principal) {
		error(400, "Say which share to remove: kind and principal.");
	}
	// Written as a branch rather than one object with a computed `kind`, because
	// the two share shapes are a discriminated union: a single object widens
	// `kind` to `string`, which the driver's filter type rejects.
	//
	// `$pull` matches the identifying fields rather than the whole element:
	// `createdAt` is part of the stored object and the client does not have it,
	// so matching on the whole thing would silently remove nothing.
	const pull =
		kind === "user"
			? { shares: { kind: "user" as const, email: principal.toLowerCase() } }
			: { shares: { kind: "group" as const, name: principal } };
	await collections.projects.updateOne(
		{ _id: access.project._id },
		{ $pull: pull, $set: { updatedAt: new Date() } }
	);
	const updated = await collections.projects.findOne({ _id: access.project._id });
	if (!updated) error(404, "No such project.");
	return json(await projectView({ project: updated, owned: true }));
};
