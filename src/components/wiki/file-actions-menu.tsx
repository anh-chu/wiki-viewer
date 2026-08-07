"use client";

import { Copy, Download, FileText, Link, MoreHorizontal, Pin } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { withWs } from "@/lib/workspace-client";
import { isMarkdown, isText } from "@/components/wiki/file-tree";
import type { useOpenFile } from "@/hooks/use-open-file";
import { usePinStore } from "@/stores/pin-store";

export interface FileActionsMenuProps {
	doc: ReturnType<typeof useOpenFile>;
	node: { path: string; name: string };
	extraItems?: ReactNode;
	activeWorkspaceId?: string | null;
}

export function FileActionsMenu({
	doc,
	node,
	extraItems,
	activeWorkspaceId = null,
}: FileActionsMenuProps) {
	const isPinned = usePinStore((s) => s.isPinned(node.path));

	const handleDownload = () => {
		const url = withWs(
			`/api/wiki/download?path=${encodeURIComponent(node.path)}`,
		);
		const a = document.createElement("a");
		a.href = url;
		a.download = node.name;
		document.body.appendChild(a);
		a.click();
		a.remove();
	};

	const handleTogglePin = () => {
		usePinStore
			.getState()
			.toggle({ path: node.path, name: node.name }, activeWorkspaceId);
	};

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					size="sm"
					variant="ghost"
					className="h-7 w-7 p-0"
					title="File actions"
				>
					<MoreHorizontal className="h-3.5 w-3.5" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-52">
				<DropdownMenuItem onClick={handleDownload}>
					<Download className="mr-2 h-3.5 w-3.5" />
					Download
				</DropdownMenuItem>
				<DropdownMenuItem onClick={handleTogglePin}>
					<Pin
						className={cn(
							"mr-2 h-3.5 w-3.5",
							isPinned && "fill-current text-amber-400",
						)}
					/>
					{isPinned ? "Unpin" : "Pin to top"}
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem onClick={() => doc.copyPath(node.path)}>
					<Copy className="mr-2 h-3.5 w-3.5" />
					Copy path
				</DropdownMenuItem>
				{isMarkdown(node.name) && (
					<DropdownMenuItem
						onClick={() => doc.copyWikiLink(node.name)}
					>
						<FileText className="mr-2 h-3.5 w-3.5" />
						Copy wiki link
					</DropdownMenuItem>
				)}
				<DropdownMenuSeparator />
				<DropdownMenuItem onClick={() => doc.copyUrl(node.path)}>
					<Link className="mr-2 h-3.5 w-3.5" />
					Copy URL
				</DropdownMenuItem>
				{isText(node.name) && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							onClick={() => void doc.copyRawContent(node.path)}
						>
							<FileText className="mr-2 h-3.5 w-3.5" />
							Copy raw content
						</DropdownMenuItem>
						<DropdownMenuItem
							onClick={() =>
								void doc.copyFormattedContent(node.path, node.name)
							}
						>
							<FileText className="mr-2 h-3.5 w-3.5" />
							Copy formatted content
						</DropdownMenuItem>
					</>
				)}
				{extraItems && (
					<>
						<DropdownMenuSeparator />
						{extraItems}
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
