import ast
import posixpath
import re
import warnings

from codedecorum.api import Finding, Rule, RuleUnit, SourceContext, SyntaxContext
from tree_sitter_language_pack import get_parser

STORE = "src/json-documents/"
DEFINITIONS = "src/config/documents.ts"
CONTRACT_TEST = "src/json-documents.test.ts"
PATH_OWNERS = {DEFINITIONS, "src/paths.ts", "src/config/schema.ts", CONTRACT_TEST}
TABLE_OWNERS = {
    "src/contracts/blackboard.ts",
    "src/blackboard/schema.sql",
    "src/blackboard/migrate.ts",
    CONTRACT_TEST,
}
PRIVATE_OWNERS = {DEFINITIONS, CONTRACT_TEST}
PATH_NAMES = {
    "FLITTERBOT_CONFIG_PATH",
    "WHATSAPP_CONFIG_PATH",
    "getWhatsAppConfigPath",
    "configPath",
    "config_path",
    "CONFIG_PATH",
    "CONFIG_FILE",
    "FLITTERBOT_CONFIG",
    "WHATSAPP_CONFIG",
}
TABLES = re.compile(r"\bjson_document(?:s|_projections)\b", re.IGNORECASE)
PRIVATE = re.compile(r"(?:^|/)json-documents/(?:file|sqlite|storage)(?:\.[\w]+)?$")
LANGUAGES = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".sh", ".sql"}


def literal(syntax, node):
    if node is None:
        return None
    if node.type in {"string", "string_literal", "raw_string", "template_string"}:
        text = syntax.text(node)
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", SyntaxWarning)
                value = ast.literal_eval(text)
            return value if isinstance(value, str) else None
        except (ValueError, SyntaxError):
            if text.startswith("`") and "${" not in text:
                return text[1:-1]
            return None
    if node.type in {"binary_expression", "binary_operator"}:
        operator = node.child_by_field_name("operator")
        if operator is not None and syntax.text(operator) == "+":
            left = literal(syntax, node.child_by_field_name("left"))
            right = literal(syntax, node.child_by_field_name("right"))
            if left is not None and right is not None:
                return left + right
    if node.type in {"concatenated_string", "concatenation"}:
        parts = [literal(syntax, child) for child in node.named_children]
        if parts and all(part is not None for part in parts):
            return "".join(parts)
    if node.type in {"word", "string_fragment", "string_content"}:
        return syntax.text(node)
    return None


def check(context, options):
    if not isinstance(context, SourceContext):
        return
    name = context.path.as_posix()
    if name.startswith(STORE) or name.startswith("codedecorum-rules/"):
        return
    shell_entry = name.startswith("installer/bin/") and not context.path.suffix
    if context.path.suffix not in LANGUAGES and not shell_entry:
        return
    if shell_entry:
        source = context.text.encode()
        syntax = SyntaxContext("bash", get_parser("bash").parse(source), source)
    else:
        syntax = context.syntax
    if syntax is None:
        yield Finding(
            detail="Cannot check document ownership: no parser for this source file."
        )
        return
    nodes = [syntax.root]
    reported = set()
    while nodes:
        node = nodes.pop()
        if "comment" in node.type:
            continue
        nodes.extend(reversed(node.named_children))
        value = literal(syntax, node)
        values = (
            []
            if value is None
            else [value, *re.findall(r"['\"`]([^'\"`\n]+)['\"`]", value)]
        )
        identifier = (
            syntax.text(node)
            if node.type
            in {"identifier", "property_identifier", "variable_name", "word"}
            else None
        )
        detail = None
        if name in {"src/paths.ts", "src/config/schema.ts"} and (
            any(
                item in {"fs", "node:fs", "fs/promises", "node:fs/promises"}
                for item in values
            )
            or identifier
            in {
                "readFile",
                "readFileSync",
                "writeFile",
                "writeFileSync",
                "unlink",
                "unlinkSync",
                "rename",
                "renameSync",
                "openLocalJsonDocuments",
            }
        ):
            detail = "Path definitions and config decoders must remain free of filesystem I/O."
        if name not in PATH_OWNERS and (
            identifier in PATH_NAMES
            or (
                any(
                    not re.search(r"\s", item)
                    and posixpath.basename(item) == "config.json"
                    for item in values
                )
            )
        ):
            detail = (
                "Managed config paths belong to the config boundary, not consumers."
            )
        if name not in TABLE_OWNERS and (
            (value is not None and TABLES.search(value))
            or (identifier is not None and TABLES.fullmatch(identifier))
        ):
            detail = "Document tables are private to storage and schema migrations."
        if name not in PRIVATE_OWNERS and (
            any(PRIVATE.search(posixpath.normpath(item)) for item in values)
            or identifier == "openLocalJsonDocuments"
        ):
            detail = (
                "Import the public config/document API, not private storage modules."
            )
        if detail and detail not in reported:
            reported.add(detail)
            yield syntax.finding(node, detail)


RULE = Rule(
    code="FJD001",
    name="JSON document ownership",
    guidance=(
        "Access runtime and WhatsApp configuration through the shared APIs so validation, "
        "manual-file synchronization, revision checks, and recovery run on every operation.\n"
        "Application code: await readConfiguration() or updateConfiguration() from "
        "src/config/documents.ts, or use loadConfig()/loadWhatsAppConfig() for resolved runtime "
        "settings. Installed scripts: use installer/scripts/config-access.mjs "
        "(installed at ~/.flitterbot/scripts/config-access.mjs). Code given a document handle "
        "uses syncAndRead() to import file edits, update() to change values while rejecting "
        "unsynced edits, and exportToFile() to explicitly replace the file with stored values.\n"
        "Keep consumers independent of storage: obtain values through these APIs rather than "
        "constructing config.json paths, importing config-path constants, reading or writing "
        "the files directly, querying json_documents/json_document_projections, or importing "
        "json-documents/file, sqlite, or storage. This applies to reads as well as writes.\n"
        "Place low-level filesystem and document-table operations in src/json-documents/. "
        "Register document paths and connect storage in src/config/documents.ts; that file "
        "uses storage helpers rather than direct table SQL. Define paths in src/paths.ts; "
        "src/config/schema.ts may reference them for validation and diagnostics. Keep both "
        "path definitions and schema decoding free of filesystem I/O. Maintain table schemas "
        "and migrations in src/contracts/blackboard.ts, src/blackboard/schema.sql, and "
        "src/blackboard/migrate.ts.\n"
        "The storage contract fixture src/json-documents.test.ts has an explicit exception "
        "to exercise these internals. Other tests follow the application boundary. Manual "
        "JSON edits by the user remain supported; this rule governs source-code access."
    ),
    check=check,
    unit=RuleUnit.FILE,
)
