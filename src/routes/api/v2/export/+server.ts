import { error, type RequestHandler } from "@sveltejs/kit";
import { collections } from "$lib/server/database";
import { authCondition } from "$lib/server/auth";
import { config } from "$lib/server/config";
import yazl from "yazl";
import { downloadFile } from "$lib/server/files/downloadFile";
import mimeTypes from "mime-types";
import { logger } from "$lib/server/logger";
import { stripRedactionValues } from "$lib/server/turnStats";

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) {
		error(401, "Not logged in");
	}

	if (!locals.isAdmin) {
		error(403, "Not admin");
	}

	if (config.ENABLE_DATA_EXPORT !== "true") {
		error(403, "Data export is not enabled");
	}

	const nExports = await collections.messageEvents.countDocuments({
		userId: locals.user._id,
		type: "export",
		expiresAt: { $gt: new Date() },
	});

	if (nExports >= 1) {
		error(
			429,
			"You have already exported your data recently. Please wait 1 hour before exporting again."
		);
	}

	const stats: {
		nConversations: number;
		nMessages: number;
		nFiles: number;
	} = {
		nConversations: 0,
		nMessages: 0,
		nFiles: 0,
	};

	const zipfile = new yazl.ZipFile();

	const promises = [
		collections.conversations
			.find({ ...authCondition(locals) })
			.toArray()
			.then(async (conversations) => {
				const formattedConversations = await Promise.all(
					conversations.map(async (conversation) => {
						stats.nConversations++;
						const hashes: string[] = [];
						conversation.messages.forEach(async (message) => {
							stats.nMessages++;
							if (message.files) {
								message.files.forEach((file) => {
									// A privacy-withheld file is listed, never exported.
									if (file.withheld) return;
									hashes.push(file.value);
								});
							}
						});
						const files = await Promise.all(
							hashes.map(async (hash) => {
								try {
									const fileData = await downloadFile(hash, conversation._id);
									return fileData;
								} catch {
									return null;
								}
							})
						);

						const filenames: string[] = [];
						files.forEach((file) => {
							if (!file) return;

							const extension = mimeTypes.extension(file.mime) || null;
							const convId = conversation._id.toString();
							const fileId = file.name.split("-")[1].slice(0, 8);
							const fileName = `file-${convId}-${fileId}` + (extension ? `.${extension}` : "");
							filenames.push(fileName);
							zipfile.addBuffer(Buffer.from(file.value, "base64"), fileName);
							stats.nFiles++;
						});

						return {
							...conversation,
							// What the chat froze or replayed from memory is server-side state, not the user's data.
							memorySnapshot: undefined,
							// The hidden values the gateway reported stay out of the file.
							messages: stripRedactionValues(conversation.messages).map((message) => {
								return {
									...message,
									memoryBlock: undefined,
									files: filenames,
									...(message.files?.some((file) => file.withheld)
										? {
												withheldFiles: message.files
													.filter((file) => file.withheld)
													.map((file) => ({
														name: file.name,
														note: `withheld by privacy rule '${file.withheld?.rule}'${
															file.withheld?.pipeline
																? ` (pipeline '${file.withheld.pipeline}')`
																: ""
														}`,
													})),
											}
										: {}),
									updates: undefined,
								};
							}),
						};
					})
				);

				zipfile.addBuffer(
					Buffer.from(JSON.stringify(formattedConversations, null, 2)),
					"conversations.json"
				);
			}),
	];

	Promise.all(promises).then(async () => {
		logger.info(
			{
				userId: locals.user?._id,
				...stats,
			},
			"Exported user data"
		);
		zipfile.end();
		if (locals.user?._id) {
			await collections.messageEvents.insertOne({
				userId: locals.user?._id,
				type: "export",
				createdAt: new Date(),
				expiresAt: new Date(Date.now() + 1000 * 60 * 60), // 1 hour
			});
		}
	});

	// @ts-expect-error - zipfile.outputStream is not typed correctly
	return new Response(zipfile.outputStream, {
		headers: {
			"Content-Type": "application/zip",
			"Content-Disposition": 'attachment; filename="export.zip"',
		},
	});
};
