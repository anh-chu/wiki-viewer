"use client";

import { useState, useEffect, type FormEvent } from "react";
import { authClient } from "@/lib/auth/client";

export default function SignInPage() {
	const [mode, setMode] = useState<"signin" | "signup">("signin");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [hasGoogle, setHasGoogle] = useState(false);
	const [passwordAuth, setPasswordAuth] = useState(true);
	const [callbackURL, setCallbackURL] = useState("/");

	useEffect(() => {
		// Learn which auth methods to show. Public endpoint, no session needed.
		fetch("/api/system/auth-config", { credentials: "include" })
			.then((r) => r.json())
			.then((data: unknown) => {
				if (data && typeof data === "object") {
					const cfg = data as { google?: boolean; passwordAuth?: boolean };
					setHasGoogle(Boolean(cfg.google));
					// Default to showing the password form unless told otherwise, so a
					// failed fetch never leaves the user with no way to sign in.
					setPasswordAuth(cfg.passwordAuth !== false);
				}
			})
			.catch(() => {});

		// Honour ?next= redirect param
		const params = new URLSearchParams(window.location.search);
		const next = params.get("next");
		if (next && next.startsWith("/")) setCallbackURL(next);
	}, []);

	async function handleSubmit(e: FormEvent) {
		e.preventDefault();
		setError(null);
		setLoading(true);
		try {
			if (mode === "signup") {
				const res = await authClient.signUp.email({
					email,
					password,
					name,
					callbackURL,
				});
				if (res.error) {
					setError(res.error.message ?? "Sign-up failed");
				} else {
					window.location.href = callbackURL;
				}
			} else {
				const res = await authClient.signIn.email({
					email,
					password,
					callbackURL,
				});
				if (res.error) {
					const status = res.error.status;
					if (status === 429) {
						setError("Too many sign-in attempts. Wait a minute and try again.");
					} else {
						setError(res.error.message ?? "Sign-in failed");
					}
				} else {
					window.location.href = callbackURL;
				}
			}
		} catch (err: unknown) {
			setError(err instanceof Error ? err.message : "Unexpected error");
		} finally {
			setLoading(false);
		}
	}

	async function handleGoogle() {
		setError(null);
		setLoading(true);
		try {
			await authClient.signIn.social({ provider: "google", callbackURL });
		} catch (err: unknown) {
			setError(err instanceof Error ? err.message : "Google sign-in failed");
			setLoading(false);
		}
	}

	return (
		<div className="min-h-screen flex items-center justify-center bg-background">
			<div className="w-full max-w-sm rounded-lg border border-border bg-card p-8 shadow-sm">
				<h1 className="mb-6 text-xl font-semibold text-foreground">Sign in to wiki-viewer</h1>

				{hasGoogle && (
					<>
						<button
							type="button"
							onClick={handleGoogle}
							disabled={loading}
							className="flex w-full items-center justify-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
						>
							<svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
								<path
									fill="#4285F4"
									d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
								/>
								<path
									fill="#34A853"
									d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
								/>
								<path
									fill="#FBBC05"
									d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
								/>
								<path
									fill="#EA4335"
									d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
								/>
							</svg>
							Continue with Google
						</button>
						{passwordAuth && (
							<div className="my-4 flex items-center gap-3">
								<hr className="flex-1 border-border" />
								<span className="text-xs text-muted-foreground">or</span>
								<hr className="flex-1 border-border" />
							</div>
						)}
					</>
				)}

				{!passwordAuth && !hasGoogle && (
					<p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
						No sign-in method is configured. Set GOOGLE_CLIENT_ID and
						GOOGLE_CLIENT_SECRET, or enable email/password auth.
					</p>
				)}

				{passwordAuth && (
				<form onSubmit={handleSubmit} className="space-y-4">
					{mode === "signup" && (
						<div>
							<label className="mb-1 block text-sm font-medium text-foreground" htmlFor="name">
								Name
							</label>
							<input
								id="name"
								type="text"
								autoComplete="name"
								value={name}
								onChange={(e) => setName(e.target.value)}
								required
								className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
							/>
						</div>
					)}
					<div>
						<label className="mb-1 block text-sm font-medium text-foreground" htmlFor="email">
							Email
						</label>
						<input
							id="email"
							type="email"
							autoComplete="email"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							required
							className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
						/>
					</div>
					<div>
						<label
							className="mb-1 block text-sm font-medium text-foreground"
							htmlFor="password"
						>
							Password
						</label>
						<input
							id="password"
							type="password"
							autoComplete={mode === "signup" ? "new-password" : "current-password"}
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							required
							minLength={8}
							className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
						/>
					</div>

					{error && (
						<p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
							{error}
						</p>
					)}

					<button
						type="submit"
						disabled={loading}
						className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
					>
						{loading
							? mode === "signup"
								? "Creating account..."
								: "Signing in..."
							: mode === "signup"
								? "Create account"
								: "Sign in"}
					</button>
				</form>
				)}

				{passwordAuth && (
				<p className="mt-4 text-center text-sm text-muted-foreground">
					{mode === "signin" ? "No account?" : "Already have an account?"}{" "}
					<button
						type="button"
						onClick={() => {
							setMode(mode === "signin" ? "signup" : "signin");
							setError(null);
						}}
						className="font-medium text-foreground underline-offset-4 hover:underline"
					>
						{mode === "signin" ? "Sign up" : "Sign in"}
					</button>
				</p>
				)}
			</div>
		</div>
	);
}
