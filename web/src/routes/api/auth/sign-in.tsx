import { createFileRoute } from "@tanstack/react-router";
import { getSignInUrl } from "@workos/authkit-tanstack-react-start";

export const Route = createFileRoute("/api/auth/sign-in")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const returnPathname = new URL(request.url).searchParams.get("returnPathname");
        const location = await getSignInUrl(
          returnPathname ? { data: { returnPathname } } : undefined,
        );
        return new Response(null, { status: 303, headers: { Location: location } });
      },
    },
  },
});
