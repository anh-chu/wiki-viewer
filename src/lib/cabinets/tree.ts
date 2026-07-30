import type { TreeNode } from "@/types";

export function findNodeByPath(
	nodes: TreeNode[],
	path: string,
): TreeNode | null {
	for (const node of nodes) {
		if (node.path === path) return node;
		if (node.children) {
			const found = findNodeByPath(node.children, path);
			if (found) return found;
		}
	}

	return null;
}
