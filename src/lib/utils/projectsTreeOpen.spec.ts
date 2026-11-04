import { describe, expect, it } from "vitest";
import {
	PROJECTS_TREE_OPEN_KEY,
	readProjectsTreeOpen,
	writeProjectsTreeOpen,
} from "./projectsTreeOpen";

const memory = () => {
	const data = new Map<string, string>();
	return {
		getItem: (k: string) => data.get(k) ?? null,
		setItem: (k: string, v: string) => void data.set(k, v),
	};
};

describe("projectsTreeOpen", () => {
	it("reads nothing stored as all closed", () => {
		expect(readProjectsTreeOpen(memory())).toEqual({ branch: false, projects: [] });
		expect(readProjectsTreeOpen(undefined)).toEqual({ branch: false, projects: [] });
	});

	it("round-trips what is open", () => {
		const storage = memory();
		writeProjectsTreeOpen(storage, { branch: true, projects: ["a", "b"] });
		expect(readProjectsTreeOpen(storage)).toEqual({ branch: true, projects: ["a", "b"] });
	});

	it("reads corrupt or foreign JSON as closed, and drops non-string ids", () => {
		const storage = memory();
		storage.setItem(PROJECTS_TREE_OPEN_KEY, "{not json");
		expect(readProjectsTreeOpen(storage)).toEqual({ branch: false, projects: [] });
		storage.setItem(PROJECTS_TREE_OPEN_KEY, JSON.stringify({ branch: "yes", projects: ["a", 3] }));
		expect(readProjectsTreeOpen(storage)).toEqual({ branch: false, projects: ["a"] });
	});

	it("survives storage that throws (a blocked or full store)", () => {
		const throwing = {
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("full");
			},
		};
		expect(readProjectsTreeOpen(throwing)).toEqual({ branch: false, projects: [] });
		expect(() => writeProjectsTreeOpen(throwing, { branch: true, projects: [] })).not.toThrow();
	});
});
