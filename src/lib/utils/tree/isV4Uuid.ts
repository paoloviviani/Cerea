import { validate, version } from "uuid";

/** An RFC 4122 version 4 UUID, the form the tab mints for the messages it proposes. */
export function isV4Uuid(id: string): boolean {
	return validate(id) && version(id) === 4;
}
