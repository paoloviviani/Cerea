import { assert, it, describe, afterEach, beforeAll, vi, expect } from "vitest";
import { z } from "zod";
import type { Cookies } from "@sveltejs/kit";
import { collections, ready } from "$lib/server/database";
import { updateUser } from "./updateUser";
import { ObjectId } from "mongodb";
import { DEFAULT_SETTINGS } from "$lib/types/Settings";
import { defaultModel } from "$lib/server/models";
import { findUser } from "$lib/server/auth";
import type { TokenSet } from "openid-client";

const userData = {
	preferred_username: "new-username",
	name: "name",
	picture: "https://example.com/avatar.png",
	sub: "1234567890",
};
Object.freeze(userData);

const locals = {
	userId: "1234567890",
	sessionId: "1234567890",
	isAdmin: false,
};

const token = {
	access_token: "access_token",
	refresh_token: "refresh_token",
	expires_at: Math.floor(Date.now() / 1000) + 3600, // Expires 1 hour from now
	expires_in: 3600,
} as TokenSet;

// @ts-expect-error SvelteKit cookies dumb mock
const cookiesMock: Cookies = {
	set: vi.fn(),
};

// `collections` is undefined until the database IIFE resolves.
beforeAll(async () => {
	await ready;
});

const insertRandomUser = async () => {
	const res = await collections.users.insertOne({
		_id: new ObjectId(),
		createdAt: new Date(),
		updatedAt: new Date(),
		username: "base-username",
		name: userData.name,
		avatarUrl: userData.picture,
		hfUserId: userData.sub,
	});

	return res.insertedId;
};

const insertRandomConversations = async (count: number) => {
	// The shared fixture catalogue (scripts/setups/vitest-setup-server.ts)
	// always publishes at least one model, so this holds in every suite that
	// imports it; asserted rather than `!` because a real empty-catalogue run
	// (see models.empty-boot.spec.ts) would otherwise fail this silently.
	assert(defaultModel, "expected the fixture catalogue to publish a default model");
	const modelId = defaultModel.id;
	const res = await collections.conversations.insertMany(
		new Array(count).fill(0).map(() => ({
			_id: new ObjectId(),
			title: "random title",
			messages: [],
			model: modelId,
			// embedding model removed in this build
			createdAt: new Date(),
			updatedAt: new Date(),
			sessionId: locals.sessionId,
		}))
	);

	return res.insertedIds;
};

describe("login", () => {
	it("should update user if existing", async () => {
		await insertRandomUser();

		await updateUser({ userData, locals, cookies: cookiesMock, token });

		const existingUser = await collections.users.findOne({ hfUserId: userData.sub });

		assert.equal(existingUser?.name, userData.name);

		expect(cookiesMock.set).toBeCalledTimes(1);
	}, 30000);

	it("should migrate pre-existing conversations for new user", async () => {
		const insertedId = await insertRandomUser();

		await insertRandomConversations(2);

		await updateUser({ userData, locals, cookies: cookiesMock, token });

		const conversationCount = await collections.conversations.countDocuments({
			userId: insertedId,
			sessionId: { $exists: false },
		});

		assert.equal(conversationCount, 2);

		await collections.conversations.deleteMany({ userId: insertedId });
	});

	it("should create default settings for new user", async () => {
		await updateUser({ userData, locals, cookies: cookiesMock, token });

		// updateUser creates a new sessionId, so we need to use the updated value
		const user = (await findUser(locals.sessionId, undefined, new URL("http://localhost"))).user;

		assert.exists(user);

		const settings = await collections.settings.findOne({ userId: user?._id });

		expect(settings).toMatchObject({
			userId: user?._id,
			updatedAt: expect.any(Date),
			createdAt: expect.any(Date),
			...DEFAULT_SETTINGS,
		});

		await collections.settings.deleteOne({ userId: user?._id });
	});

	it("should migrate pre-existing settings for pre-existing user", async () => {
		const { insertedId } = await collections.settings.insertOne({
			sessionId: locals.sessionId,
			updatedAt: new Date(),
			createdAt: new Date(),
			...DEFAULT_SETTINGS,
			shareConversationsWithModelAuthors: false,
		});

		await updateUser({ userData, locals, cookies: cookiesMock, token });

		const settings = await collections.settings.findOne({
			_id: insertedId,
			sessionId: { $exists: false },
		});

		assert.exists(settings);

		const user = await collections.users.findOne({ hfUserId: userData.sub });

		expect(settings).toMatchObject({
			userId: user?._id,
			updatedAt: expect.any(Date),
			createdAt: expect.any(Date),
			...DEFAULT_SETTINGS,
			shareConversationsWithModelAuthors: false,
		});

		await collections.settings.deleteOne({ userId: user?._id });
	});
});

afterEach(async () => {
	await collections.users.deleteMany({ hfUserId: userData.sub });
	await collections.sessions.deleteMany({});

	locals.userId = "1234567890";
	locals.sessionId = "1234567890";
	vi.clearAllMocks();
});

/**
 * What the house IdP sends for a local account without a display name
 * (verified live: `GET /chat/login/callback` answered 500 with a ZodError on
 * `name` and on `email` for exactly this shape). OpenID Connect leaves `name`
 * optional, and an issuer-local address legitimately has no dotted domain —
 * so a relying party that throws on either is wrong on its own terms, not
 * merely unkind to one provider.
 */
describe("login without a name claim", () => {
	const localSub = "house-idp-local-admin";
	const localsFor = () => ({ ...locals });

	async function cleanup() {
		await collections.users.deleteMany({ hfUserId: localSub });
	}

	it("falls back to preferred_username when the provider sends no name", async () => {
		await updateUser({
			userData: {
				preferred_username: "somebody",
				sub: localSub,
				email: "somebody@example.org",
			},
			locals: localsFor(),
			cookies: cookiesMock,
			token,
		});

		const user = await collections.users.findOne({ hfUserId: localSub });
		assert.equal(user?.name, "somebody");
		await cleanup();
	});

	it("accepts an issuer-local address like admin@local", async () => {
		await updateUser({
			userData: { name: "Admin", sub: localSub, email: "admin@local" },
			locals: localsFor(),
			cookies: cookiesMock,
			token,
		});

		const user = await collections.users.findOne({ hfUserId: localSub });
		assert.equal(user?.email, "admin@local");
		await cleanup();
	});

	it("accepts both missing together, falling back to the email local part", async () => {
		await updateUser({
			userData: { sub: localSub, email: "admin@local" },
			locals: localsFor(),
			cookies: cookiesMock,
			token,
		});

		const user = await collections.users.findOne({ hfUserId: localSub });
		assert.equal(user?.name, "admin");
		await cleanup();
	});

	it("still refuses a response with nothing human-readable to seed from", async () => {
		// sub alone identifies but never names: the panel footer and the
		// account label would have nothing to show. This must keep failing,
		// and for this reason — assert the ZodError itself, not just any
		// throw, so the test cannot pass on an unrelated failure.
		await expect(
			updateUser({
				userData: { sub: localSub },
				locals: localsFor(),
				cookies: cookiesMock,
				token,
			})
		).rejects.toThrowError(z.ZodError);
		await cleanup();
	});

	it("reads the display name from a non-default name claim", async () => {
		await updateUser({
			userData: { username: "usernamed-person", sub: localSub, email: "u@example.org" },
			locals: localsFor(),
			cookies: cookiesMock,
			token,
			nameClaim: "username",
		});

		const user = await collections.users.findOne({ hfUserId: localSub });
		assert.equal(user?.name, "usernamed-person");
		await cleanup();
	});

	it("stores an ordinary address verbatim, for the allowlists", async () => {
		// ALLOWED_USER_EMAILS/DOMAINS compare exact strings and a split
		// domain in +server.ts. Any normalisation here would silently loosen
		// those admission checks, so the stored value must equal the claim.
		await updateUser({
			userData: { name: "Person", sub: localSub, email: "Admin@Example.ORG" },
			locals: localsFor(),
			cookies: cookiesMock,
			token,
		});

		const user = await collections.users.findOne({ hfUserId: localSub });
		assert.equal(user?.email, "Admin@Example.ORG");
		assert.equal(user?.name, "Person");
		await cleanup();
	});
});
