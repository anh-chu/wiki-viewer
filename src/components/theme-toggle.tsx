"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";

export function ThemeToggle({ className }: { className?: string }) {
	const { resolvedTheme, setTheme } = useTheme();
	return (
		<Button
			size="sm"
			variant="ghost"
			className={`h-7 w-7 p-0 ${className ?? ""}`}
			title={resolvedTheme === "dark" ? "Switch to light" : "Switch to dark"}
			onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
		>
			{resolvedTheme === "dark" ? (
				<Sun className="h-3.5 w-3.5" />
			) : (
				<Moon className="h-3.5 w-3.5" />
			)}
		</Button>
	);
}
