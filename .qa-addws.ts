import { createWorkspace, listWorkspaces } from "../../src/lib/workspaces";

const roots = (await listWorkspaces()).map((w) => w.rootDir);
if (roots.includes("/home/sil/wiki-viewer/.worktrees/comments-rebuild")) {
	console.log("already registered");
} else {
	const ws = await createWorkspace({
		name: "comments-rebuild",
		rootDir: "/home/sil/wiki-viewer/.worktrees/comments-rebuild",
		createdBy: "5ZXnilanN7HBugEoM2sGG3qMfpvPBoSt",
	});
	console.log("created", ws.id, ws.rootDir);
}
console.log("all:", JSON.stringify((await listWorkspaces()).map((w) => [w.id, w.name, w.rootDir])));
