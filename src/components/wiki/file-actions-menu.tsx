"use client";

import { Copy, FileText, Link, MoreHorizontal } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isMarkdown, isText } from "@/components/wiki/file-tree";
import type { useOpenFile } from "@/hooks/use-open-file";

export interface FileActionsMenuProps {
	doc: ReturnType<typeof useOpenFile>;
	node: { path: string; name: string };
	extraItems?: ReactNode;
}

export function FileActionsMenu({ doc, node, extraItems }: FileActionsMenuProps) {
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
