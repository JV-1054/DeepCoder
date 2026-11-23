# DeepCoder and the DeepSeek Harness — setup guide

This guide registers DeepCoder as a model provider inside the DeepSeek Harness.
It is the only part of the setup that touches the harness itself.

## The short way

Run `scripts\setup.cmd` and follow the prompts. It performs every step of this
guide: the configuration, the key, the route in the harness profile, the
automatic start and the bridge itself. It prints `PASS` or `FAIL` for every check.

The steps below describe what it does, so every part can also be done by hand.

## What the harness needs

1. A running local bridge on `http://127.0.0.1:8899`
2. The provider key in an environment variable named `AGENTROUTER_API_KEY`
3. One route entry in the harness profile patch file

## Where the harness keeps the route

```
%DSH_HOME%\profiles\<profile>\cordis.patch.yml
```

On a normal Windows installation that is:

```
C:\Users\<you>\.dsh\profiles\desktop\cordis.patch.yml
```

The file is a YAML **array**. Every route is one entry that starts with `- id:`.
New entries are added at the end of the array. Do not add a second top level key
and do not nest the entries under an existing one.

## Step 1 — start the bridge

```cmd
scripts\start.cmd
```

or

```bash
node deepcoder.cjs
```

The last line of the start output must be a base URL like:

```
Harness base URL: http://127.0.0.1:8899/v1
```

Check it at any time:

```bash
curl http://127.0.0.1:8899/health
```

## Step 2 — give the harness the key

The short way is `setup.cmd`, which asks for the key with the echo off and saves
it for the current Windows user. The long way is:

```cmd
setx AGENTROUTER_API_KEY "sk-..."
setx DEEPCODER_CONFIG "C:\path\to\DeepCoder\config\deepcoder-config.json"
```

`node deepcoder.cjs --set-key` does the same from the command line: it reads one
line from the standard input and stores it in the user environment. The value
travels through a pipe, so it never appears on a command line.

`setx` writes to the user environment. Close the harness completely and start it
again, otherwise it keeps the old environment.

The variable name comes from `apiKeyEnv` in `config/deepcoder-config.json`.
Change it there if you prefer a different name, and use the same name in the route.

The harness sends the key itself. If it cannot — because it was started before the
variable existed — the bridge adds the key from its own environment, so a request
without an `Authorization` header still works. The bridge needs the variable as
well: the Startup entry inherits it from Windows at every sign-in, `setup.cmd`
sets it for the bridge it starts, and a bridge that still misses it looks the
value up in the user registry. `"injectApiKey": false` in
`config/deepcoder-config.json` turns that fallback off.

## Step 3 — register the provider route

Close the harness first, then run:

```bash
node deepcoder.cjs --install-dsh-profile
```

The profile is found automatically: the profile of the running harness
(`DSH_PROFILE`), then the profile named in `dshProfile` of the configuration,
then the only profile that exists on the machine. The chosen name is written back
into the configuration, so the next run uses the same one.

The command edits the profile patch file in place. It never replaces anything
that is already there:

- If the file already has an `llm-pi-ai` entry, the DeepCoder provider is merged
  into its `providers` map. Every provider that was already listed stays exactly
  as it was.
- If the file already has an `agent-default-model` entry, it is left alone. The
  default model of the profile is not changed.
- Only when an entry is missing is it added. A second run of the command refreshes
  the DeepCoder block in place, so a newer DeepCoder can update its own route
  without touching any other provider.

The merged provider looks like this:

```yaml
providers:
  otari:                      # your existing provider, untouched
    displayName: Otari
    ...
  deepcoder:                  # added by DeepCoder
    displayName: DeepCoder
    apiKeyEnv: AGENTROUTER_API_KEY
    api: openai-responses
    baseURL: http://127.0.0.1:8899/v1
    timeoutMs: 600000
    streamIdleTimeoutMs: 600000
    models:
      - id: "gpt-6.1-sol"
        name: "GPT-6.1-SOL"
        contextWindow: 262144
        maxTokens: 16384
        input:
          - text
          - image
        reasoningEfforts:
          off: "none"
          minimal: "minimal"
          low: "low"
          medium: "medium"
          high: "high"
          xhigh: "xhigh"
          max: "max"
    compat:
      supportsDeveloperRole: true
      supportsMaxOutputTokens: true
      supportsStrictMode: false
```

The command prints what it did:

```
Profile file: C:\Users\<you>\.dsh\profiles\desktop\cordis.patch.yml
  The provider route was merged into the existing providers map.
  The existing default model of the profile was kept. ...
```

If you prefer to edit the file by hand, the same text is in
`config/dsh-provider.example.yml` and can be printed with:

```bash
node deepcoder.cjs --print-dsh-profile
```

When you edit by hand and the file already has an `llm-pi-ai` entry, copy the
`deepcoder:` block into its `providers` map. Do not add a second `llm-pi-ai`
entry: the later entry of the same id would replace the earlier one and the
providers of the first entry would disappear.

A backup of the profile file is worth keeping before the first run:

```cmd
copy "%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml" "%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml.bak"
```

### Notes on the values

| Value | Why |
| --- | --- |
| `api: openai-responses` | `gpt-6.1-sol` refuses `/v1/chat/completions`, so the Responses protocol is the only one that works. |
| `baseURL` | Must end with `/v1`. The harness passes it through unchanged and appends `/responses` to it. |
| `timeoutMs` | `600000`, because a reasoning answer can stay silent for minutes before the first stream event. |
| `compat` | The Responses protocol reads `supportsDeveloperRole`, `supportsMaxOutputTokens` and `supportsStrictMode`. The harness rejects a route that sets a switch no model on the route could read, so only those three are written. |

### Reasoning and tool calls

The model entry lists every reasoning level the harness offers:

```
off      minimal  low  medium  high  xhigh  max
```

The values are the reasoning effort names of the Responses API, so the harness
passes a chosen level straight to the provider. A level without a value would mean
"supported but send nothing", which is why `off` carries the value `none`.

The route sets `supportsStrictMode: false`. The harness then sends plain JSON
Schema tool definitions, the provider answers with a function call, and the
`function_call_output` the harness sends back is forwarded as it is. All of it was
checked live through the bridge.

## Step 4 — start the harness and check the provider

Start the harness and open *Settings → Models*.

The provider list must contain **DeepCoder** with the model **gpt-6.1-sol**. The
harness calls `GET http://127.0.0.1:8899/v1/models` for the list, which the
bridge answers from its own configuration. The provider id `deepcoder` is
permanent, so do not rename it after the first start.

The harness may also offer the **Fetch available models** button. It calls the
same endpoint, so it returns the same single model.

## Step 5 — use the model

Pick **DeepCoder / gpt-6.1-sol** in the model list of the harness and talk to it.
The default model of the profile is left as it was, so nothing else changes when
DeepCoder is added.

## What can go wrong

**The harness shows the provider but every request fails with 401.** The upstream
refused the client fingerprint. The bridge sends the pi client identity —
`pi (<platform> <release>; <arch>)`, computed at runtime — plus
`originator: pi` by default. Do not change `user-agent` in
`config/deepcoder-config.json` to something like `deepcoder/1.0.3`; AgentRouter
only accepts the client names it knows (pi, Codex, OpenCode). Run
`node tools/probe-upstream.cjs` to see which identity your provider accepts.

**"Model gpt-6.1-sol does not support /v1/chat/completions".** The route was
registered with `api: openai-completions`. Change it to `api: openai-responses`
and restart the harness.

**"Unsupported parameter: 'temperature'".** A parameter that the model rejects
reached the provider. The default configuration removes `temperature`, `top_p`
and `frequency_penalty`. Add the name to `stripParams` in
`config/deepcoder-config.json` if a new one appears.

**The answer stops after a few words.** The output budget was too small. The
default floor is 16384 tokens, which matches the output limit of the model.

**The harness shows `UNKNOWN_MODEL`.** The model id in the route and in `models`
in `config/deepcoder-config.json` must match the id the provider returns. Both
are `gpt-6.1-sol` here.

**The harness shows `MISSING_CREDENTIAL`.** `AGENTROUTER_API_KEY` is not visible
to the harness process. Set it with `setx` and restart the harness completely.

**Every request answers 401 with an invalid key.** No key reached the provider.
The harness sends it when it can resolve `apiKeyEnv`; the bridge adds it from its
own environment when the request arrives without one, and from the user registry
when its own environment does not have it yet. Run `node deepcoder.cjs
--self-test`: it prints the key as a hint (`sk-ABCD...WXYZ`) so you can see which
value was used. Check that `AGENTROUTER_API_KEY` is set for the user that runs
the bridge and restart the bridge after changing it.

**The answer takes minutes.** Normal for a reasoning model. The bridge and the
route both use a 600 second upstream timeout.

## Running the bridge automatically

`setup.cmd` installs the automatic start. Two mechanisms exist and each one
covers a different case:

| Mechanism | When it runs | Needs administrator |
| --- | --- | --- |
| Boot task `DeepCoder` | at every Windows boot, before any user signs in | yes |
| Sign-in entry | at every sign-in | no |

The boot task runs as `SYSTEM`, so it can only be created from an administrator
terminal. `setup.cmd` does that automatically when it is started as administrator
(*Run as administrator* on the right click menu).

The sign-in entry is a small VBS script in the Windows Startup folder that starts
the bridge hidden at every sign-in. This works for every user, with or without
administrator rights, and `setup.cmd` always installs it.

Neither of them opens a window: the bridge is started through
`scripts/deepcoder-autostart.vbs` with the hidden window style.

Check what is active:

```bash
node deepcoder.cjs --status
```

Remove both again:

```cmd
scripts\uninstall.cmd
```
