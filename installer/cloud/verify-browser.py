"""Exercise the real cloud UI in an isolated headless browser, with no stub data."""

import argparse
import json
import uuid

from playwright.sync_api import expect, sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument("--url", required=True)
parser.add_argument("--api-url", required=True)
parser.add_argument("--session-id", required=True)
parser.add_argument("--hostname", required=True)
parser.add_argument("--model-label", required=True)
parser.add_argument("--executable")
parser.add_argument(
    "--storage-state", help="Playwright storage state from a completed WorkOS sign-in"
)
parser.add_argument("--screenshot", required=True)
args = parser.parse_args()
nonce = "CLOUD-UI-" + uuid.uuid4().hex[:12]

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, executable_path=args.executable)
    try:
        context = browser.new_context(
            viewport={"width": 1440, "height": 1000}, storage_state=args.storage_state
        )
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        settings = json.dumps({"baseUrl": args.api_url, "useStubFallback": False})
        page.add_init_script(
            "localStorage.setItem('flitterbot.web.control-surface', "
            + json.dumps(settings)
            + ")"
        )
        page.goto(f"{args.url.rstrip('/')}/streams/{args.session_id}")
        if "/api/auth/sign-in" in page.url or "authkit.app" in page.url:
            raise RuntimeError(
                "WorkOS sign-in required; pass --storage-state from an authenticated browser context"
            )
        page.get_by_role("button", name=args.model_label, exact=True).wait_for()
        expect(page.locator("main p").first).to_be_visible()
        editor = page.get_by_role(
            "textbox", name="Press i to jump here · / for skills · @ for paths"
        )
        message = (
            f"Use bash to run hostname. Reply in one plain-text paragraph with {nonce} "
            "followed by the hostname. Do not write files, commit, close, or start agents."
        )
        editor.fill(message)
        expect(editor).to_have_value(message)
        editor.press("Enter")
        reply = page.locator("main p").filter(has_text=nonce)
        expect(reply).to_contain_text(args.hostname, timeout=180_000)
        page.reload()
        expect(reply).to_contain_text(args.hostname, timeout=30_000)
        page.get_by_role("button", name="Diff Opt K", exact=True).click()
        expect(page.get_by_text("cloud-demo.txt", exact=True).first).to_be_visible(
            timeout=30_000
        )
        page.screenshot(path=args.screenshot)
        assert not errors, errors
        print(
            json.dumps(
                {
                    "passed": True,
                    "nonce": nonce,
                    "checks": [
                        "browser submission",
                        "live worker reply",
                        "reload persistence",
                        "rendered Git diff",
                    ],
                    "pageErrors": errors,
                }
            )
        )
    finally:
        browser.close()
