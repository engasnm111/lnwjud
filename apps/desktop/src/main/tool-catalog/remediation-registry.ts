import type { RemediationAction, ResolvedRemediation, UiLocale } from '@lnwjud/ipc-contracts';

interface RemediationDefinition {
  readonly id: string;
  readonly title: Readonly<Record<UiLocale, string>>;
  readonly explanation: Readonly<Record<UiLocale, string>>;
  readonly steps: Readonly<Record<UiLocale, readonly string[]>>;
  readonly actions: readonly RemediationAction[];
}

const DEFINITIONS: readonly RemediationDefinition[] = [
  remediation(
    'add_project', 'Add a project', 'เพิ่มโปรเจกต์',
    'Register and activate a project workspace before using workspace-scoped tools.',
    'เพิ่มและเปิดใช้งาน project workspace ก่อนใช้เครื่องมือที่ต้องทำงานในโปรเจกต์',
    [{ kind: 'open_settings', target: 'projects' }],
    ['Open Projects.', 'Add the folder you want lnwjud to work in.', 'Mark the project active, then recheck.'],
    ['เปิดหน้าโปรเจกต์', 'เพิ่มโฟลเดอร์ที่ต้องการให้ lnwjud ทำงาน', 'เปิด Active ให้โปรเจกต์นั้น แล้วตรวจใหม่'],
  ),
  remediation(
    'install_git', 'Install Git', 'ติดตั้ง Git',
    'Git is not available to the lnwjud runtime.',
    'runtime ของ lnwjud ยังหา Git ไม่พบ',
    [{ kind: 'open_official_url', target: 'git_download' }, { kind: 'recheck', requirementIds: ['executable_git'] }],
    ['Install Git for Windows from the official installer.', 'Make sure git.exe is available to newly started applications.', 'Recheck this item.'],
    ['ติดตั้ง Git for Windows จากเว็บทางการ', 'ให้ git.exe ใช้งานได้กับโปรแกรมที่เปิดใหม่', 'กลับมากดตรวจใหม่'],
  ),
  remediation(
    'install_ripgrep', 'Install ripgrep', 'ติดตั้ง ripgrep',
    'ripgrep is required for fast text search. The installer normally bundles it; use the official release only if the bundled runtime is missing.',
    'ripgrep จำเป็นสำหรับค้นหาข้อความแบบเร็ว ปกติ installer จะมีมาให้แล้ว ให้ติดตั้งจากเว็บทางการเฉพาะเมื่อ runtime ที่มากับโปรแกรมหายหรือเสีย',
    [{ kind: 'open_official_url', target: 'ripgrep_releases' }, { kind: 'recheck', requirementIds: ['executable_ripgrep'] }],
    ['Recheck first after reinstalling/updating lnwjud.', 'If still missing, install ripgrep from the official release.', 'Reopen lnwjud and recheck.'],
    ['ถ้าเพิ่งติดตั้ง/อัปเดต lnwjud ให้ตรวจใหม่ก่อน', 'หากยังไม่พบ ให้ติดตั้ง ripgrep จาก release ทางการ', 'เปิด lnwjud ใหม่แล้วตรวจอีกครั้ง'],
  ),
  remediation(
    'configure_codex', 'Enable and configure Codex', 'เปิดและตั้งค่า Codex',
    'Codex delegation is optional and is disabled by default so it cannot consume Codex quota accidentally.',
    'Codex delegation เป็นฟีเจอร์เสริมและปิดไว้เป็นค่าเริ่มต้นเพื่อไม่ให้ใช้โควต้า Codex โดยไม่ตั้งใจ',
    [
      { kind: 'set_user_setting', setting: 'codexToolsEnabled', value: true },
      { kind: 'open_settings', target: 'tools_codex' },
      { kind: 'recheck', requirementIds: ['codex_runtime'] },
    ],
    ['Use Enable codex_* below for one-click app configuration, or open the Codex Delegation card.', 'If Codex itself is not installed/available, install or sign in to the Codex runtime separately.', 'Restart Local MCP / Tunnel if requested, then recheck.'],
    ['กด เปิด codex_* ด้านล่างเพื่อเปิดค่าของโปรแกรมทันที หรือไปที่การ์ด Codex Delegation', 'ถ้ายังไม่มี Codex runtime ให้ติดตั้ง/ลงชื่อเข้าใช้ Codex ให้พร้อมก่อน', 'Restart Local MCP / Tunnel หากระบบแจ้ง แล้วตรวจใหม่'],
  ),
  remediation(
    'configure_tunnel', 'Configure Secure Tunnel', 'ตั้งค่า Secure Tunnel',
    'Secure Tunnel needs a valid API key/profile and a running tunnel runtime.',
    'Secure Tunnel ต้องมี API key/profile ที่ถูกต้องและ runtime ที่กำลังทำงาน',
    [{ kind: 'open_settings', target: 'tunnel' }, { kind: 'recheck', requirementIds: ['tunnel_runtime'] }],
    ['Open Secure Tunnel settings.', 'Complete the guided setup and start the tunnel.', 'Return here and recheck.'],
    ['เปิดการตั้งค่า Secure Tunnel', 'ทำ Guided Setup ให้ครบและ Start Tunnel', 'กลับมาหน้านี้แล้วตรวจใหม่'],
  ),
  remediation(
    'connect_external_mcp', 'Connect an external MCP server', 'เชื่อมต่อ External MCP',
    'No enabled external MCP server is currently connected.',
    'ยังไม่มี External MCP Server ที่เปิดใช้งานและเชื่อมต่อสำเร็จ',
    [{ kind: 'open_settings', target: 'mcp_servers' }, { kind: 'recheck', requirementIds: ['external_mcp_connection'] }],
    ['Open MCP & Extensions settings.', 'Add or enable the intended MCP server and save.', 'Reconnect/restart it if needed, then recheck.'],
    ['เปิด MCP & Extensions', 'เพิ่มหรือเปิด MCP Server ที่ต้องการแล้วบันทึก', 'Reconnect/Restart หากจำเป็น แล้วตรวจใหม่'],
  ),
  remediation(
    'configure_pdf_provider', 'Install the PDF provider', 'ติดตั้งตัวอ่าน PDF',
    'PDF extraction needs pdftotext.exe. lnwjud can download a pinned Poppler for Windows package, verify its SHA-256, install it inside the lnwjud data directory, and configure the provider path automatically.',
    'การอ่านข้อความ PDF ต้องมี pdftotext.exe โดย lnwjud สามารถดาวน์โหลด Poppler for Windows เวอร์ชันที่กำหนดไว้ ตรวจ SHA-256 ติดตั้งไว้ในโฟลเดอร์ข้อมูลของ lnwjud และตั้งค่าพาธให้อัตโนมัติ',
    [{ kind: 'install_pdf_provider' }, { kind: 'open_settings', target: 'tools_local_providers' }, { kind: 'recheck', requirementIds: ['local_pdf_provider'] }],
    ['Click Download & install PDF Provider.', 'lnwjud verifies the pinned archive before extraction and configures pdftotext.exe automatically.', 'Use Local Providers only if you prefer a manually installed pdftotext.exe, then recheck.'],
    ['กด ดาวน์โหลดและติดตั้ง PDF Provider', 'lnwjud จะตรวจ SHA-256 ของไฟล์ที่กำหนดไว้ก่อนแตกไฟล์ และตั้งค่า pdftotext.exe ให้อัตโนมัติ', 'ใช้ Local Providers เฉพาะกรณีต้องการเลือก pdftotext.exe ที่ติดตั้งเอง แล้วกดตรวจใหม่'],
  ),
  remediation(
    'configure_lsp', 'Configure a Language Server', 'ตั้งค่า Language Server',
    'LSP tools need at least one resolvable language-server command.',
    'เครื่องมือ LSP ต้องมีคำสั่ง Language Server ที่เรียกใช้งานได้อย่างน้อยหนึ่งภาษา',
    [{ kind: 'open_settings', target: 'tools_local_providers' }, { kind: 'recheck', requirementIds: ['configured_lsp'] }],
    ['Open Tools → Local Providers.', 'Add LANGUAGE=COMMAND, for example typescript=["typescript-language-server","--stdio"] or python=["pyright-langserver","--stdio"].', 'Save changes, restart Local MCP / Tunnel if requested, then recheck.'],
    ['เปิด Tools → Local Providers', 'เพิ่ม LANGUAGE=COMMAND เช่น typescript=["typescript-language-server","--stdio"] หรือ python=["pyright-langserver","--stdio"]', 'บันทึกค่า Restart Local MCP / Tunnel หากระบบแจ้ง แล้วตรวจใหม่'],
  ),
  remediation(
    'configure_database_target', 'Provide a database target when calling the tool', 'ระบุฐานข้อมูลตอนเรียกเครื่องมือ',
    'There is no global database setting. Database tools are input-dependent and require a read-only SQLite target inside a registered workspace for each call.',
    'ไม่มีค่าฐานข้อมูลส่วนกลาง เครื่องมือฐานข้อมูลขึ้นกับ input และต้องระบุไฟล์ SQLite แบบอ่านอย่างเดียวภายในโปรเจกต์ที่ลงทะเบียนในแต่ละครั้งที่เรียก',
    [],
    ['Register the project that contains the SQLite file.', 'When calling the database tool, pass that SQLite file as the read-only target.', 'No app setting needs to be enabled.'],
    ['ลงทะเบียนโปรเจกต์ที่มีไฟล์ SQLite', 'ตอนเรียกเครื่องมือฐานข้อมูลให้ส่งไฟล์ SQLite นั้นเป็น read-only target', 'รายการนี้ไม่มีสวิตช์ใน Settings ที่ต้องเปิด'],
  ),
  remediation(
    'configure_windows_sandbox', 'Enable Windows Sandbox', 'เปิดใช้ Windows Sandbox',
    'Windows Sandbox is a Windows optional feature; it is not configured in lnwjud Tools settings.',
    'Windows Sandbox เป็น Optional Feature ของ Windows ไม่ได้ตั้งค่าจากหน้า Tools ของ lnwjud',
    [
      { kind: 'open_system_settings', target: 'windows_optional_features' },
      { kind: 'copy_command', commandId: 'enable_windows_sandbox' },
      { kind: 'recheck', requirementIds: ['windows_sandbox'] },
    ],
    ['Open Turn Windows features on or off.', 'Enable Windows Sandbox. Windows may require administrator permission and a restart.', 'Alternatively copy the PowerShell command and run it in an elevated PowerShell window.', 'After Windows is ready, recheck.'],
    ['เปิด Turn Windows features on or off', 'ติ๊ก Windows Sandbox โดย Windows อาจขอสิทธิ์ Administrator และ Restart เครื่อง', 'หรือคัดลอกคำสั่ง PowerShell แล้วรันใน PowerShell แบบ Administrator', 'เมื่อ Windows พร้อมแล้วกลับมากดตรวจใหม่'],
  ),
  remediation(
    'configure_wsl', 'Install or enable WSL', 'ติดตั้งหรือเปิด WSL',
    'WSL tools require a working Windows Subsystem for Linux installation.',
    'เครื่องมือ WSL ต้องมี Windows Subsystem for Linux ที่ใช้งานได้',
    [
      { kind: 'open_system_settings', target: 'windows_optional_features' },
      { kind: 'copy_command', commandId: 'install_wsl' },
      { kind: 'recheck', requirementIds: ['wsl_runtime'] },
    ],
    ['Use wsl --install from an elevated terminal on supported Windows versions, or enable the required Windows features manually.', 'Restart Windows if requested.', 'Complete the initial Linux distribution setup, then recheck.'],
    ['ใช้ wsl --install ใน Terminal แบบ Administrator บน Windows ที่รองรับ หรือเปิด Windows Feature ที่เกี่ยวข้องเอง', 'Restart Windows หากระบบร้องขอ', 'ตั้งค่า Linux distribution ครั้งแรกให้เสร็จ แล้วตรวจใหม่'],
  ),
  remediation(
    'configure_browser_cdp', 'Start the lnwjud managed browser', 'เปิดเบราว์เซอร์ที่ lnwjud จัดการ',
    'Browser/CDP tools need the managed browser runtime to be running. lnwjud can start it automatically; you do not need to add Chrome debugging flags yourself.',
    'เครื่องมือ Browser/CDP ต้องมี Managed Browser ที่กำลังทำงาน lnwjud สามารถเปิดให้ได้อัตโนมัติ ไม่ต้องเพิ่ม Chrome debugging flags เอง',
    [{ kind: 'launch_managed_browser' }, { kind: 'recheck', requirementIds: ['browser_cdp'] }],
    ['Click Start managed browser.', 'Wait for the managed Chrome window to open.', 'Recheck. Tools that operate a page will still select/create an explicit tab_id at call time.'],
    ['กด เปิด Managed Browser', 'รอให้หน้าต่าง Managed Chrome เปิดขึ้น', 'กดตรวจใหม่ โดยตอนใช้งานจริงเครื่องมือจะเลือก/สร้าง tab_id ที่ชัดเจนอีกครั้ง'],
  ),
  remediation(
    'configure_browser_events', 'Use a live browser diagnostics session', 'ใช้ Browser Diagnostics Session ที่กำลังทำงาน',
    'Console/network context is session-dependent. Start the managed browser first, then run the browser tool against an explicit tab so events can be retained for that session.',
    'ข้อมูล Console/Network ขึ้นกับ session ให้เปิด Managed Browser ก่อน แล้วเรียกเครื่องมือกับ tab ที่ระบุชัดเพื่อเก็บ event ของ session นั้น',
    [{ kind: 'launch_managed_browser' }, { kind: 'recheck', requirementIds: ['browser_cdp'] }],
    ['Start the managed browser.', 'Use dom_cdp list_tabs/new_tab and keep the returned tab_id.', 'Run the console/network tool for that tab. This is runtime input, not a persistent Settings switch.'],
    ['เปิด Managed Browser', 'ใช้ dom_cdp list_tabs/new_tab แล้วเก็บ tab_id ที่คืนมา', 'เรียกเครื่องมือ Console/Network กับ tab นั้น รายการนี้เป็น runtime input ไม่ใช่สวิตช์ถาวรใน Settings'],
  ),
  remediation(
    'configure_permissions', 'Allow the tool in Security settings', 'อนุญาตเครื่องมือใน Security',
    'The active permission profile currently denies this tool class.',
    'Permission Profile ปัจจุบันปฏิเสธสิทธิ์ของเครื่องมือนี้',
    [{ kind: 'open_settings', target: 'security_profile' }],
    ['Open Security settings.', 'Choose a profile/Custom decision that allows the declared permission if you trust the operation.', 'Return to Tools and recheck.'],
    ['เปิด Security', 'เลือก Profile หรือ Custom decision ที่อนุญาตสิทธิ์ตามที่เครื่องมือประกาศ เมื่อคุณยอมรับความเสี่ยงนั้น', 'กลับหน้า Tools แล้วตรวจใหม่'],
  ),
  remediation(
    'feature_not_available', 'Runtime backend is not included in this version', 'เวอร์ชันนี้ยังไม่มีส่วนทำงานของเครื่องมือนี้',
    'The tool is listed so its delivery state is visible, but this installed lnwjud version does not include the runtime/provider that executes it. This is not a missing Windows or user setting, and there is no Settings switch to turn it on.',
    'รายการนี้ยังแสดงไว้เพื่อบอกสถานะตามจริง แต่ lnwjud เวอร์ชันที่ติดตั้งยังไม่มี runtime/provider ที่ใช้ทำงานจริง ไม่ใช่การตั้งค่า Windows หรือการตั้งค่าของคุณที่ขาด และไม่มีสวิตช์ใน Settings ที่เปิดแล้วจะใช้งานได้',
    [],
    ['Check the feature_delivery requirement above for the exact backend/provider this tool needs.', 'Do not change unrelated local settings.', 'When a lnwjud version containing that runtime/provider is installed, recheck the tool catalog.'],
    ['ดูข้อกำหนด feature_delivery ด้านบนเพื่อดูชื่อ backend/provider ที่เครื่องมือนี้ยังขาด', 'ไม่ต้องเปลี่ยน Settings หรือการตั้งค่าของ Windows ที่ไม่เกี่ยวข้อง', 'เมื่อใช้ lnwjud รุ่นที่รวม runtime/provider นั้นแล้ว ให้กดตรวจใหม่อีกครั้ง'],
  ),
  remediation(
    'feature_planned', 'Planned tool — not available yet', 'เครื่องมือที่วางแผนไว้ — ยังใช้ไม่ได้',
    'The tool is listed for discoverability but its runtime is still planned. It cannot be enabled in Settings in this version.',
    'เครื่องมือนี้แสดงไว้เพื่อให้เห็นแผนความสามารถ แต่ runtime ยังอยู่สถานะ planned และเปิดจาก Settings ในเวอร์ชันนี้ไม่ได้',
    [],
    ['No user action can enable this tool in the current build.', 'Use an operational alternative when one is listed, or update to a later build after the feature is implemented.'],
    ['ไม่มีขั้นตอนฝั่งผู้ใช้ที่ทำให้เครื่องมือนี้เปิดได้ใน build ปัจจุบัน', 'ใช้เครื่องมือทางเลือกที่พร้อมอยู่ หรืออัปเดต build ใหม่หลังมี implementation แล้ว'],
  ),
  remediation(
    'recheck_runtime', 'Recheck runtime', 'ตรวจ runtime ใหม่',
    'Run the safe readiness probe again after changing the related dependency or setting.',
    'รัน readiness probe แบบ read-only ใหม่หลังแก้ dependency หรือ setting ที่เกี่ยวข้อง',
    [{ kind: 'recheck', requirementIds: [] }],
    ['Apply the related setup change first.', 'Then recheck the runtime.'],
    ['แก้การตั้งค่าหรือ dependency ที่เกี่ยวข้องก่อน', 'จากนั้นตรวจ runtime ใหม่'],
  ),
];

export const OFFICIAL_URL_TARGETS = Object.freeze({
  git_download: 'https://git-scm.com/download/win',
  ripgrep_releases: 'https://github.com/BurntSushi/ripgrep/releases',
} as const);

export const COPY_COMMANDS = Object.freeze({
  check_git: 'git --version',
  check_ripgrep: 'rg --version',
  install_wsl: 'wsl --install',
  enable_windows_sandbox: 'Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All',
} as const);

export class RemediationRegistry {
  readonly #definitions = new Map(DEFINITIONS.map((definition) => [definition.id, definition] as const));

  public has(id: string): boolean { return this.#definitions.has(id); }
  public ids(): readonly string[] { return [...this.#definitions.keys()]; }
  public resolve(locale: UiLocale, ids: readonly string[] = this.ids()): readonly ResolvedRemediation[] {
    return [...new Set(ids)].map((id) => {
      const definition = this.#definitions.get(id);
      if (definition === undefined) throw new Error(`Unknown remediation id: ${id}`);
      return {
        id,
        title: definition.title[locale],
        explanation: definition.explanation[locale],
        steps: definition.steps[locale],
        actions: definition.actions,
      };
    });
  }
}

function remediation(
  id: string,
  enTitle: string,
  thTitle: string,
  enExplanation: string,
  thExplanation: string,
  actions: readonly RemediationAction[],
  enSteps: readonly string[] = [enExplanation],
  thSteps: readonly string[] = [thExplanation],
): RemediationDefinition {
  return { id, title: { en: enTitle, th: thTitle }, explanation: { en: enExplanation, th: thExplanation }, steps: { en: enSteps, th: thSteps }, actions };
}
