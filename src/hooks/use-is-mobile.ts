"use client";
import { useEffect, useState } from "react";

export function useIsMobile(query = "(max-width: 767px)") {
	const [isMobile, setIsMobile] = useState(false); // SSR-safe default
	useEffect(() => {
		const mql = window.matchMedia(query);
		const on = () => setIsMobile(mql.matches);
		on();
		mql.addEventListener("change", on);
		return () => mql.removeEventListener("change", on);
	}, [query]);
	return isMobile;
}
