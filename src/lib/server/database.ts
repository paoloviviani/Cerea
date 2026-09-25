import { GridFSBucket, MongoClient, ReadPreference } from "mongodb";
// The mongodb driver require()s these lazily at runtime when the connection
// string uses authMechanism=MONGODB-AWS (IRSA / web identity in prod). Import
// them statically so dependency-cleanup passes don't strip them from
// package.json again — that already happened twice (97bf7184, 6d842efc) and
// the second time crash-looped prod with MongoMissingDependencyError.
import "aws4";
import "@aws-sdk/credential-providers";
import type { Conversation } from "$lib/types/Conversation";
import type {
	KnowledgeConfig,
	KnowledgeConfigChange,
	KnowledgeDocument,
	VectorStore,
} from "$lib/types/VectorStore";
import type { Project } from "$lib/types/Project";
import type { McpConnector, McpOauthPending, McpToken } from "$lib/types/McpConnector";
import type { SharedConversation } from "$lib/types/SharedConversation";
import type { AbortedGeneration } from "$lib/types/AbortedGeneration";
import type { Generation, GenerationEvent } from "$lib/types/Generation";
import type { TurnState } from "$lib/types/TurnState";
import type { McpElicitation } from "$lib/types/McpElicitation";
import type { ParkedCall } from "$lib/types/ParkedCall";
import type { NestedAgentCall } from "$lib/types/NestedAgentCall";
import type { Settings } from "$lib/types/Settings";
import type { User } from "$lib/types/User";
import type { MessageEvent } from "$lib/types/MessageEvent";
import type { Session } from "$lib/types/Session";
import type { Assistant } from "$lib/types/Assistant";
import type { Report } from "$lib/types/Report";
import type { ConversationStats } from "$lib/types/ConversationStats";
import type { MigrationResult } from "$lib/types/MigrationResult";
import type { Semaphore } from "$lib/types/Semaphore";
import type { CodeExecutionOutput } from "$lib/types/CodeExecutionOutput";
import { MongoMemoryServer } from "mongodb-memory-server";
import { logger } from "$lib/server/logger";
import { building } from "$app/environment";
import { onExit } from "./exitHandler";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync, mkdirSync } from "fs";
import { findRepoRoot } from "./findRepoRoot";
import type { ConfigKey } from "$lib/types/ConfigKey";
import type { Skill } from "$lib/types/Skill";
import type { Memory } from "$lib/types/Memory";
import type { CodeAuditEntry, CodeDevice } from "$lib/types/CodeAgent";
import { config } from "$lib/server/config";

export const CONVERSATION_STATS_COLLECTION = "conversations.stats";

export class Database {
	private client?: MongoClient;
	private mongoServer?: MongoMemoryServer;

	private static instance: Database;

	private async init() {
		const DB_FOLDER =
			config.MONGO_STORAGE_PATH ||
			join(findRepoRoot(dirname(fileURLToPath(import.meta.url))), "db");

		if (!config.MONGODB_URL) {
			logger.warn("No MongoDB URL found, using in-memory server");

			logger.info(`Using database path: ${DB_FOLDER}`);
			// Create db directory if it doesn't exist
			if (!existsSync(DB_FOLDER)) {
				logger.info(`Creating database directory at ${DB_FOLDER}`);
				mkdirSync(DB_FOLDER, { recursive: true });
			}

			this.mongoServer = await MongoMemoryServer.create({
				instance: {
					dbName: config.MONGODB_DB_NAME + (import.meta.env.MODE === "test" ? "-test" : ""),
					dbPath: DB_FOLDER,
				},
				binary: {
					version: "7.0.18",
				},
			});
			this.client = new MongoClient(this.mongoServer.getUri(), {
				directConnection: config.MONGODB_DIRECT_CONNECTION === "true",
			});
		} else {
			this.client = new MongoClient(config.MONGODB_URL, {
				directConnection: config.MONGODB_DIRECT_CONNECTION === "true",
			});
		}

		try {
			logger.info("Connecting to database");
			await this.client.connect();
			logger.info("Connected to database");
			this.client.db(config.MONGODB_DB_NAME + (import.meta.env.MODE === "test" ? "-test" : ""));
			await this.initDatabase();
		} catch (err) {
			logger.error(err, "Error connecting to database");
			process.exit(1);
		}

		// Disconnect DB on exit. Registered `last` so other exit handlers (e.g. the
		// reaper finalizing in-flight generations) finish their writes before the
		// client is force-closed.
		onExit(
			async () => {
				logger.info("Closing database connection");
				await this.client?.close(true);
				await this.mongoServer?.stop();
			},
			{ last: true }
		);
	}

	public static async getInstance(): Promise<Database> {
		if (!Database.instance) {
			Database.instance = new Database();
			await Database.instance.init();
		}

		return Database.instance;
	}

	/**
	 * Return mongoClient
	 */
	public getClient(): MongoClient {
		if (!this.client) {
			throw new Error("Database not initialized");
		}

		return this.client;
	}

	/**
	 * Return map of database's collections
	 */
	public getCollections() {
		if (!this.client) {
			throw new Error("Database not initialized");
		}

		const db = this.client.db(
			config.MONGODB_DB_NAME + (import.meta.env.MODE === "test" ? "-test" : "")
		);

		// Collections with default readPreference (primary) - critical for read-after-write consistency
		const conversations = db.collection<Conversation>("conversations");
		const settings = db.collection<Settings>("settings");
		const users = db.collection<User>("users");
		const sessions = db.collection<Session>("sessions");
		const messageEvents = db.collection<MessageEvent>("messageEvents");
		const abortedGenerations = db.collection<AbortedGeneration>("abortedGenerations");
		const generations = db.collection<Generation>("generations");
		const generationEvents = db.collection<GenerationEvent>("generationEvents");
		const turnStates = db.collection<TurnState>("turnStates");
		const mcpElicitations = db.collection<McpElicitation>("mcpElicitations");
		const parkedCalls = db.collection<ParkedCall>("parkedCalls");
		const nestedAgentCalls = db.collection<NestedAgentCall>("nestedAgentCalls");
		const semaphores = db.collection<Semaphore>("semaphores");
		const configCollection = db.collection<ConfigKey>("config");
		const migrationResults = db.collection<MigrationResult>("migrationResults");
		const sharedConversations = db.collection<SharedConversation>("sharedConversations");
		// Primary read preference, like conversations: the redirect after a
		// create reads the project back immediately, and secondary lag there
		// shows as a 404 on a project that does exist.
		const projects = db.collection<Project>("projects");
		// The knowledge pipeline, chat-side since ADR 0070: bases and their
		// documents here, passages and vectors in the chat's own Postgres.
		const vectorStores = db.collection<VectorStore>("vectorStores");
		const knowledgeDocuments = db.collection<KnowledgeDocument>("knowledgeDocuments");
		const knowledgeConfig = db.collection<KnowledgeConfig>("knowledgeConfig");
		// Append-only: every change to that configuration, kept because
		// "which model was this base built with, and who moved the default"
		// gets asked long after the change (ADR 0070).
		const knowledgeConfigHistory = db.collection<KnowledgeConfigChange>("knowledgeConfigHistory");
		// Connector definitions, one person's authorisations, and in-flight
		// flows (ADR 0064). Primary read preference throughout: a callback
		// reads back the state it just wrote, and secondary lag there is an
		// expired sign-in for something that worked.
		// User skills, owner-only with no sharing (ADR 0072), plus the
		// deployment-scope rows the admin panel manages in the same collection
		// (readable by all, writable only by an administrator): one document
		// per skill, code seeds bootstrapped as rows on first read.
		const skills = db.collection<Skill>("skills");
		// Standing personal facts, owner-only with no sharing at all. Read on
		// every turn and tiny per user, so it stays on the primary: a stale
		// read here would drop a fact somebody just saved out of the very next
		// prompt, which reads as the feature not working.
		const memories = db.collection<Memory>("memories");
		const mcpConnectors = db.collection<McpConnector>("mcpConnectors");
		const mcpTokens = db.collection<McpToken>("mcpTokens");
		const mcpOauthPending = db.collection<McpOauthPending>("mcpOauthPending");
		// Paired coding-agent devices for the `/code` panel (one person's
		// machines running the paseo daemon). The daemon owns every live
		// thing — workspaces, sessions, transcripts — so these rows are the
		// only agent state this app persists: who paired what, and whether
		// the pairing completed.
		const codeDevices = db.collection<CodeDevice>("codeDevices");
		// What people did through /code's machine powers (ADR 0090): the
		// explorer's raw reads and refusals, later terminals and writes.
		// Never content. Kept 90 days.
		const codeAudit = db.collection<CodeAuditEntry>("codeAudit");
		const bucket = new GridFSBucket(db, { bucketName: "files" });
		// The bucket's own file documents, for indexing only — reads and
		// deletes go through `bucket`, which also handles the chunks.
		const bucketFiles = db.collection("files.files");
		// Computed `execute_code` deliverables (ADR 0073's amendment): a separate
		// bucket from message attachments so a conversation's deliverables can be
		// listed and wiped as a unit (deletion, TTL sweep) without a collection
		// scan over unrelated attachment bytes.
		const codeExecutionOutputs = db.collection<CodeExecutionOutput>("codeExecutionOutputs");
		const codeOutputBucket = new GridFSBucket(db, { bucketName: "codeOutputs" });

		// Collections with secondaryPreferred - heavy reads, can tolerate slight replication lag
		const secondaryPreferred = ReadPreference.SECONDARY_PREFERRED;
		const assistants = db.collection<Assistant>("assistants", {
			readPreference: secondaryPreferred,
		});
		const conversationStats = db.collection<ConversationStats>(CONVERSATION_STATS_COLLECTION, {
			readPreference: secondaryPreferred,
		});
		const reports = db.collection<Report>("reports", {
			readPreference: secondaryPreferred,
		});
		const tools = db.collection("tools", {
			readPreference: secondaryPreferred,
		});
		return {
			conversations,
			projects,
			skills,
			memories,
			vectorStores,
			knowledgeDocuments,
			knowledgeConfig,
			knowledgeConfigHistory,
			mcpConnectors,
			mcpTokens,
			mcpOauthPending,
			codeDevices,
			codeAudit,
			conversationStats,
			assistants,
			reports,
			sharedConversations,
			abortedGenerations,
			generations,
			generationEvents,
			turnStates,
			mcpElicitations,
			parkedCalls,
			nestedAgentCalls,
			settings,
			users,
			sessions,
			messageEvents,
			bucket,
			bucketFiles,
			codeExecutionOutputs,
			codeOutputBucket,
			migrationResults,
			semaphores,
			tools,
			config: configCollection,
		};
	}

	/**
	 * Init database once connected: Index creation
	 * @private
	 */
	private async initDatabase() {
		const {
			conversations,
			projects,
			skills,
			memories,
			mcpConnectors,
			mcpTokens,
			mcpOauthPending,
			codeDevices,
			codeAudit,
			conversationStats,
			assistants,
			reports,
			sharedConversations,
			abortedGenerations,
			generations,
			generationEvents,
			turnStates,
			mcpElicitations,
			parkedCalls,
			nestedAgentCalls,
			settings,
			users,
			sessions,
			messageEvents,
			semaphores,
			config,
			codeExecutionOutputs,
			bucketFiles,
		} = this.getCollections();

		conversations
			.createIndex(
				{ sessionId: 1, updatedAt: -1 },
				{ partialFilterExpression: { sessionId: { $exists: true } } }
			)
			.catch((e) =>
				logger.error(e, "Error creating index for conversations by sessionId and updatedAt")
			);
		conversations
			.createIndex(
				{ userId: 1, updatedAt: -1 },
				{ partialFilterExpression: { userId: { $exists: true } } }
			)
			.catch((e) =>
				logger.error(e, "Error creating index for conversations by userId and updatedAt")
			);
		conversations
			.createIndex(
				{ "message.id": 1, "message.ancestors": 1 },
				{ partialFilterExpression: { userId: { $exists: true } } }
			)
			.catch((e) =>
				logger.error(e, "Error creating index for conversations by messageId and ancestors")
			);
		mcpConnectors
			.createIndex({ userId: 1, updatedAt: -1 })
			.catch((e) => logger.error(e, "Error creating index for mcpConnectors by userId"));
		// One authorisation per person per connector, and the uniqueness is the
		// point rather than an optimisation: two rows would mean two tokens and
		// no rule for which one a call uses.
		mcpTokens
			.createIndex({ connectorId: 1, userId: 1 }, { unique: true })
			.catch((e) => logger.error(e, "Error creating index for mcpTokens"));
		mcpOauthPending
			.createIndex({ state: 1 }, { unique: true })
			.catch((e) => logger.error(e, "Error creating index for mcpOauthPending by state"));
		// A TTL, so an abandoned consent screen does not leave a usable state
		// behind. `expiresAfterSeconds: 0` means "when the date in the field
		// passes", which is what the flow already sets.
		mcpOauthPending
			.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
			.catch((e) => logger.error(e, "Error creating TTL index for mcpOauthPending"));
		projects
			.createIndex({ userId: 1, updatedAt: -1 })
			.catch((e) => logger.error(e, "Error creating index for projects by userId"));
		// Skill names are unique per (scope, owner), not per owner: a personal
		// skill and a deployment skill may share a name — prompt assembly
		// already prefers the personal one, and the service's explicit
		// pre-checks keep each namespace itself collision-free with readable
		// errors. The previous {userId, name} key could not express that: a
		// deployment row stores its creating admin's userId, so an admin
		// importing a deployment skill named like one of their own user
		// skills hit a duplicate key.
		//
		// Awaited — unlike every other index op in this function, which floats:
		// a migration has ordering requirements (writes after `ready` must see
		// the new key and never the old one), while a missing secondary index
		// elsewhere merely costs a query plan until its build lands.
		await skills
			.createIndex({ scope: 1, userId: 1, name: 1 }, { unique: true })
			.then(() =>
				// The retired key, dropped only after its replacement exists —
				// sequencing matters, not just ordering: firing the drop while
				// the create's hybrid build is still running on this collection
				// fails the drop, and a failure here must keep the old guard
				// rather than leaving none. Absent on fresh databases (nothing
				// to migrate) and already gone on re-runs — either way not an
				// error worth logging.
				skills.dropIndex("userId_1_name_1").catch(() => undefined)
			)
			.catch((e) => logger.error(e, "Error creating index for skills by scope, userId and name"));
		skills
			.createIndex({ userId: 1, updatedAt: -1 })
			.catch((e) => logger.error(e, "Error creating index for skills by userId"));
		// Memory is read whole, per user, on every turn, and written rarely —
		// so one compound index serves both the prompt build and the screen.
		// The sort is ascending because oldest-first is the order the block
		// renders in and the end the budget drops from (see memory/service).
		memories
			.createIndex({ userId: 1, createdAt: 1 })
			.catch((e) => logger.error(e, "Error creating index for memories by userId"));
		// Deployment-scope names are unique across the deployment: two
		// administrators must not publish two different procedures under one
		// `@name`. Partial, so the per-owner user rows above are untouched.
		skills
			.createIndex(
				{ scope: 1, name: 1 },
				{ unique: true, partialFilterExpression: { scope: "deployment" } }
			)
			.catch((e) => logger.error(e, "Error creating index for deployment skills by name"));
		// Serves "which projects are shared with me", which is a query by the
		// viewer's own email or one of their group names — both of them values
		// inside the same array, which is why one multikey index covers it.
		projects
			.createIndex({ "shares.email": 1 }, { sparse: true })
			.catch((e) => logger.error(e, "Error creating index for projects by share email"));
		projects
			.createIndex({ "shares.name": 1 }, { sparse: true })
			.catch((e) => logger.error(e, "Error creating index for projects by share group"));
		// A project page lists its conversations newest first.
		conversations
			.createIndex(
				{ projectId: 1, updatedAt: -1 },
				{ partialFilterExpression: { projectId: { $exists: true } } }
			)
			.catch((e) => logger.error(e, "Error creating index for conversations by projectId"));
		// Not strictly necessary, could use _id, but more convenient. Also for stats
		// To do stats on conversation messages
		conversations
			.createIndex({ "messages.createdAt": 1 }, { sparse: true })
			.catch((e) =>
				logger.error(e, "Error creating index for conversations by messages createdAt")
			);
		// Unique index for stats
		conversationStats
			.createIndex(
				{
					type: 1,
					"date.field": 1,
					"date.span": 1,
					"date.at": 1,
					distinct: 1,
				},
				{ unique: true }
			)
			.catch((e) =>
				logger.error(
					e,
					"Error creating index for conversationStats by type, date.field and date.span"
				)
			);
		// Allow easy check of last computed stat for given type/dateField
		conversationStats
			.createIndex({
				type: 1,
				"date.field": 1,
				"date.at": 1,
			})
			.catch((e) => logger.error(e, "Error creating index for abortedGenerations by updatedAt"));
		abortedGenerations
			.createIndex({ updatedAt: 1 }, { expireAfterSeconds: 30 })
			.catch((e) =>
				logger.error(
					e,
					"Error creating index for abortedGenerations by updatedAt and expireAfterSeconds"
				)
			);
		abortedGenerations
			.createIndex({ conversationId: 1 }, { unique: true })
			.catch((e) =>
				logger.error(e, "Error creating index for abortedGenerations by conversationId")
			);
		generations
			.createIndex({ generationId: 1 }, { unique: true })
			.catch((e) => logger.error(e, "Error creating index for generations by generationId"));
		generations
			.createIndex({ conversationId: 1, startedAt: -1 })
			.catch((e) =>
				logger.error(e, "Error creating index for generations by conversationId and startedAt")
			);
		generations
			.createIndex(
				{ userId: 1, updatedAt: -1 },
				{ partialFilterExpression: { userId: { $exists: true } } }
			)
			.catch((e) => logger.error(e, "Error creating index for generations by userId"));
		generations
			.createIndex(
				{ sessionId: 1, updatedAt: -1 },
				{ partialFilterExpression: { sessionId: { $exists: true } } }
			)
			.catch((e) => logger.error(e, "Error creating index for generations by sessionId"));
		// Serves the reaper's query: still-running runs ordered by heartbeat age.
		generations
			.createIndex({ status: 1, lastHeartbeatAt: 1 })
			.catch((e) =>
				logger.error(e, "Error creating index for generations by status and lastHeartbeatAt")
			);
		generations
			.createIndex(
				{ endedAt: 1 },
				{
					expireAfterSeconds: 7 * 24 * 60 * 60,
					partialFilterExpression: { endedAt: { $exists: true } },
				}
			)
			.catch((e) => logger.error(e, "Error creating TTL index for generations by endedAt"));

		// Unique so a retried insert is idempotent, and compound so it is also the
		// exact index the replay/tail range scan uses.
		generationEvents
			.createIndex({ generationId: 1, seq: 1 }, { unique: true })
			.catch((e) =>
				logger.error(e, "Error creating index for generationEvents by generationId and seq")
			);
		// The turn-scoped replay/tail scan, and the max-seq read a resumed producer
		// seeds its counter from. Not unique: legacy events lack the keys, and the
		// parked-call lease is what guarantees a single writer.
		generationEvents
			.createIndex({ conversationId: 1, messageId: 1, seq: 1 })
			.catch((e) => logger.error(e, "Error creating turn-scoped index for generationEvents"));
		generationEvents
			.createIndex({ createdAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 })
			.catch((e) => logger.error(e, "Error creating TTL index for generationEvents by createdAt"));

		// Expired on the same 24h clock as generationEvents.
		nestedAgentCalls
			.createIndex({ conversationId: 1, messageId: 1, createdAt: 1 })
			.catch((e) => logger.error(e, "Error creating turn-scoped index for nestedAgentCalls"));
		nestedAgentCalls
			.createIndex({ createdAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 })
			.catch((e) => logger.error(e, "Error creating TTL index for nestedAgentCalls by createdAt"));

		// One state document per turn; the unique key is what makes the upsert in
		// turnState.ts race-safe. Ended turns expire like ended generations do.
		turnStates
			.createIndex({ conversationId: 1, messageId: 1 }, { unique: true })
			.catch((e) => logger.error(e, "Error creating unique turn index for turnStates"));
		turnStates
			.createIndex({ endedAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 })
			.catch((e) => logger.error(e, "Error creating TTL index for turnStates by endedAt"));
		// Serve the live feed's per-tick owner scan, like the same pair on `generations`.
		turnStates
			.createIndex(
				{ userId: 1, updatedAt: -1 },
				{ partialFilterExpression: { userId: { $exists: true } } }
			)
			.catch((e) => logger.error(e, "Error creating index for turnStates by userId"));
		turnStates
			.createIndex(
				{ sessionId: 1, updatedAt: -1 },
				{ partialFilterExpression: { sessionId: { $exists: true } } }
			)
			.catch((e) => logger.error(e, "Error creating index for turnStates by sessionId"));

		parkedCalls
			.createIndex({ parkedCallId: 1 }, { unique: true })
			.catch((e) => logger.error(e, "Error creating index for parkedCalls by parkedCallId"));
		// The sweep itself: due rows, oldest first. Compound so a waiting row that is
		// not yet due costs nothing to skip.
		parkedCalls
			.createIndex({ status: 1, resumeAt: 1 })
			.catch((e) => logger.error(e, "Error creating index for parkedCalls by status and resumeAt"));
		parkedCalls
			.createIndex({ conversationId: 1 })
			.catch((e) => logger.error(e, "Error creating index for parkedCalls by conversationId"));
		// Rows outlive their usefulness once resumed; a week is long enough to debug a
		// run and short enough that the collection stays small.
		parkedCalls
			.createIndex({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 })
			.catch((e) => logger.error(e, "Error creating TTL index for parkedCalls by createdAt"));

		mcpElicitations
			.createIndex({ elicitationId: 1 }, { unique: true })
			.catch((e) => logger.error(e, "Error creating index for mcpElicitations by elicitationId"));
		// Keyed off expiry, not creation: MCP_ELICITATION_TIMEOUT_MS is unbounded, and a row
		// swept while its form is still on screen makes answering it 404.
		mcpElicitations
			.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 })
			.catch((e) => logger.error(e, "Error creating TTL index for mcpElicitations by expiresAt"));

		sharedConversations.createIndex({ hash: 1 }, { unique: true }).catch((e) => logger.error(e));
		settings
			.createIndex({ sessionId: 1 }, { unique: true, sparse: true })
			.catch((e) => logger.error(e, "Error creating index for settings by sessionId"));
		settings
			.createIndex({ userId: 1 }, { unique: true, sparse: true })
			.catch((e) => logger.error(e, "Error creating index for settings by userId"));
		settings
			.createIndex({ assistants: 1 })
			.catch((e) => logger.error(e, "Error creating index for settings by assistants"));
		users
			.createIndex({ hfUserId: 1 }, { unique: true })
			.catch((e) => logger.error(e, "Error creating index for users by hfUserId"));
		users
			.createIndex({ sessionId: 1 }, { unique: true, sparse: true })
			.catch((e) => logger.error(e, "Error creating index for users by sessionId"));
		// No unicity because due to renames & outdated info from oauth provider, there may be the same username on different users
		users
			.createIndex({ username: 1 })
			.catch((e) => logger.error(e, "Error creating index for users by username"));
		// For stats queries filtering users by creation date
		users
			.createIndex({ createdAt: 1 })
			.catch((e) => logger.error(e, "Error creating index for users by createdAt"));
		messageEvents
			.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 1 })
			.catch((e) => logger.error(e, "Error creating index for messageEvents by expiresAt"));
		sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch((e) => logger.error(e));
		sessions
			.createIndex({ sessionId: 1 }, { unique: true })
			.catch((e) => logger.error(e, "Error creating index for sessions by sessionId"));
		assistants
			.createIndex({ createdById: 1, userCount: -1 })
			.catch((e) =>
				logger.error(e, "Error creating index for assistants by createdById and userCount")
			);
		assistants
			.createIndex({ userCount: 1 })
			.catch((e) => logger.error(e, "Error creating index for assistants by userCount"));
		assistants
			.createIndex({ review: 1, userCount: -1 })
			.catch((e) => logger.error(e, "Error creating index for assistants by review and userCount"));
		assistants
			.createIndex({ modelId: 1, userCount: -1 })
			.catch((e) =>
				logger.error(e, "Error creating index for assistants by modelId and userCount")
			);
		assistants
			.createIndex({ searchTokens: 1 })
			.catch((e) => logger.error(e, "Error creating index for assistants by searchTokens"));
		assistants
			.createIndex({ last24HoursCount: 1 })
			.catch((e) => logger.error(e, "Error creating index for assistants by last24HoursCount"));
		assistants
			.createIndex({ last24HoursUseCount: -1, useCount: -1, _id: 1 })
			.catch((e) =>
				logger.error(e, "Error creating index for assistants by last24HoursUseCount and useCount")
			);
		reports
			.createIndex({ assistantId: 1 })
			.catch((e) => logger.error(e, "Error creating index for reports by assistantId"));
		reports
			.createIndex({ createdBy: 1, assistantId: 1 })
			.catch((e) =>
				logger.error(e, "Error creating index for reports by createdBy and assistantId")
			);

		// Unique index for semaphore and migration results
		semaphores.createIndex({ key: 1 }, { unique: true }).catch((e) => logger.error(e));
		semaphores
			.createIndex({ deleteAt: 1 }, { expireAfterSeconds: 1 })
			.catch((e) => logger.error(e, "Error creating index for semaphores by deleteAt"));
		conversations
			.createIndex({
				"messages.from": 1,
				createdAt: 1,
			})
			.catch((e) =>
				logger.error(e, "Error creating index for conversations by messages from and createdAt")
			);

		conversations
			.createIndex({
				userId: 1,
				sessionId: 1,
			})
			.catch((e) =>
				logger.error(e, "Error creating index for conversations by userId and sessionId")
			);

		// For stats aggregation jobs that filter by createdAt/updatedAt alone
		conversations
			.createIndex({ createdAt: 1 })
			.catch((e) => logger.error(e, "Error creating index for conversations by createdAt"));
		conversations
			.createIndex({ updatedAt: 1 })
			.catch((e) => logger.error(e, "Error creating index for conversations by updatedAt"));

		config
			.createIndex({ key: 1 }, { unique: true })
			.catch((e) => logger.error(e, "Error creating index for config by key"));

		// Dedup + the access-checked download lookup: one row per distinct
		// deliverable a conversation has produced.
		codeExecutionOutputs
			.createIndex({ conversationId: 1, sha256: 1 }, { unique: true })
			.catch((e) => logger.error(e, "Error creating index for codeExecutionOutputs by sha256"));
		// Conversation-delete cleanup lists a conversation's rows by this alone.
		codeExecutionOutputs
			.createIndex({ conversationId: 1 })
			.catch((e) =>
				logger.error(e, "Error creating index for codeExecutionOutputs by conversationId")
			);
		// 30-day retention (ADR 0073's amendment). This expires the metadata row;
		// `DeliverableReaper`'s own sweep is what actually frees the GridFS bytes
		// (a native TTL index on `codeOutputs.files` would drop the `files` doc
		// without its `chunks`, since GridFS deletion is not cascading) — this
		// index is the backstop that still bounds the metadata collection even if
		// that sweep is not running.
		codeExecutionOutputs
			.createIndex({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 })
			.catch((e) => logger.error(e, "Error creating TTL index for codeExecutionOutputs"));

		codeAudit
			.createIndex({ at: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 })
			.catch((e) => logger.error(e, "Error creating TTL index for codeAudit"));
		codeAudit
			.createIndex({ userId: 1, at: -1 })
			.catch((e) => logger.error(e, "Error creating index for codeAudit by userId"));

		// A person's paired machines, newest first.
		codeDevices
			.createIndex({ userId: 1, updatedAt: -1 })
			.catch((e) => logger.error(e, "Error creating index for codeDevices by userId"));
		// One row per (user, machine): a machine reconnecting with the same
		// `X-Pystino-Machine-Id` updates its existing row rather than
		// spawning a second one (`machines.ts`'s `onHello`).
		codeDevices
			.createIndex({ userId: 1, machineId: 1 }, { unique: true })
			.catch((e) => logger.error(e, "Error creating unique index for codeDevices by machineId"));

		// Attachments by owner tag (and, for owner-keyed surfaces, the message
		// they were sent with): `attachmentStore.findAttachments` runs once per
		// user message on every transcript load, and both it and the deletions
		// by owner — chat's `deleteConversationAttachments`, a device revoke's
		// anchored-prefix delete — would otherwise scan the whole bucket.
		bucketFiles
			.createIndex({ "metadata.conversation": 1, "metadata.messageId": 1 })
			.catch((e) => logger.error(e, "Error creating index for attachment owner tags"));
	}
}

export let collections: ReturnType<typeof Database.prototype.getCollections>;

export const ready = (async () => {
	if (!building) {
		const db = await Database.getInstance();
		collections = db.getCollections();
	} else {
		collections = {} as unknown as ReturnType<typeof Database.prototype.getCollections>;
	}
})();

export async function getCollectionsEarly(): Promise<
	ReturnType<typeof Database.prototype.getCollections>
> {
	await ready;
	if (!collections) {
		throw new Error("Database not initialized");
	}
	return collections;
}
