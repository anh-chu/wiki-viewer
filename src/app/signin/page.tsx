import SignInForm from "./signin-form";
import { passwordAuthEnabled } from "@/lib/auth/server";

// Server component: resolve the available auth methods at render time so the
// initial HTML already reflects the configuration. This prevents the password
// form from flashing on load when it is disabled (AUTH_DISABLE_PASSWORD=1).
export const dynamic = "force-dynamic";

export default function SignInPage() {
	const google = Boolean(
		process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
	);
	return (
		<SignInForm initialPasswordAuth={passwordAuthEnabled} initialGoogle={google} />
	);
}
