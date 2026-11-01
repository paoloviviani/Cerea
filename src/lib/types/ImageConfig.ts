/**
 * The image-generation settings an administrator saves (Administration ->
 * Assistant -> Images): one document, site-wide.
 */
export interface ImageConfig {
	/** The gateway model that draws images; null or absent: the default (env, else the first granted). */
	model?: string | null;
	/** Whether `generate_image` waits for the user's approval card before each call. */
	askFirst?: boolean;
	updatedAt: Date;
}
