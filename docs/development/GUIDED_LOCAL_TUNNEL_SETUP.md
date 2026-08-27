# Guided Local Tunnel Setup

lnwjud includes a bilingual first-run guide for connecting ChatGPT through the official OpenAI Secure MCP Tunnel without requiring users to edit config files or run Terminal commands.

## Who sees the first-run Tips dialog

The dialog is shown only when the local tunnel setup is pristine: there is no saved Runtime API key, no configured tunnel profile, no persisted Tunnel ID, and the guide has not previously been dismissed or completed. Existing users with a key or profile are not interrupted automatically. If setup was started but not completed, lnwjud resumes the Secure Tunnel guide from the state it can derive from the actual tunnel status.

Choosing **Set up later / ไว้ทีหลัง** only dismisses the automatic Tips dialog. The guide remains available from Home and **Settings > Secure Tunnel**.

## Five-step setup

### ภาษาไทย

1. เปิดหน้า OpenAI Tunnel Settings เลือกองค์กรที่ใช้กับ ChatGPT สร้าง tunnel แล้วคัดลอกค่า `tunnel_...` มาวางใน lnwjud หากสร้างไม่ได้ ให้ตรวจสิทธิ์ Tunnels Read + Manage.
2. เปิดหน้า API Keys สร้าง Runtime API key ที่มีสิทธิ์ Tunnels Read + Use แล้ววางใน lnwjud. คีย์เต็มจะแสดงจาก OpenAI เพียงครั้งเดียว.
3. กด **ตั้งค่าและตรวจสอบ** ให้ lnwjud ใช้ `tunnel-client` ที่มากับโปรแกรมเพื่อสร้าง local profile และตรวจสอบการเชื่อมต่อ.
4. กด **Start Tunnel**. lnwjud จะถือว่าขั้นตอนฝั่งเครื่องเสร็จเมื่อสถานะจริงกลับมาเป็น Running เท่านั้น และจะ reconnect Tunnel ID เดิมอัตโนมัติเมื่อจำเป็น.
5. เปิด ChatGPT Plugins. หากยังไม่เปิด Developer mode ให้ไปที่ **Settings > Security and login > Developer mode**, เพิ่ม connection, เลือก **Tunnel**, แล้วเลือกหรือวาง Tunnel ID.

### English

1. Open OpenAI Tunnel Settings, choose the organization used with ChatGPT, create a tunnel, and paste the `tunnel_...` value into lnwjud. If tunnel creation is unavailable, verify Tunnels Read + Manage permissions.
2. Open API Keys, create a Runtime API key with Tunnels Read + Use, and paste it into lnwjud. OpenAI displays the full secret only once.
3. Select **Configure and check**. lnwjud uses the bundled `tunnel-client` to create the local profile and validate the connection.
4. Select **Start Tunnel**. Local setup is considered complete only after the real status returns Running. lnwjud reconnects the same Tunnel ID automatically when required.
5. Open ChatGPT Plugins. If Developer mode is off, go to **Settings > Security and login > Developer mode**, add a connection, choose **Tunnel**, then select or paste the Tunnel ID.

## Official pages opened by the guide

The renderer cannot supply an arbitrary URL. It sends only one of three fixed targets through IPC, and the main process resolves them to these HTTPS pages:

- Tunnel Settings: `https://platform.openai.com/settings/organization/tunnels`
- API Keys: `https://platform.openai.com/api-keys`
- ChatGPT Plugins: `https://chatgpt.com/plugins`

If opening a page fails, the guide shows the same allowlisted URL so it can be copied manually.

## Credential boundary

The Runtime API key is passed to the existing desktop credential path only when the user saves it. On Windows it is protected with DPAPI and stored locally. lnwjud does not operate a central credential server. The onboarding state stored in renderer storage is only one finite UI value: `not_started`, `in_progress`, `dismissed`, or `completed`.

The full API key and Tunnel ID draft are not stored in localStorage or sessionStorage. The Runtime API key draft is cleared from React state after a successful save and whenever the guide closes or leaves the key step. Status and logs use only safe state plus a masked Tunnel ID.

## Reopening, replacing a key, and troubleshooting

Open **Settings > Secure Tunnel** and choose **Open setup guide** at any time. Existing users can expand **Advanced settings and troubleshooting** to replace a revoked Runtime API key, override the bundled `tunnel-client` path when diagnosing an installation problem, reconfigure the profile, reconnect or stop the tunnel, and inspect persistent runtime status.

Use **Doctor** to check the local tunnel-client/profile/runtime/health conditions and **Live Logs** to inspect sanitized runtime evidence. A revoked key should be replaced through the existing Runtime API key save path, then the profile/runtime should be checked again before retrying Start Tunnel.

## What lnwjud can and cannot prove

lnwjud can verify the local configuration and observe the tunnel reaching **Running**. It cannot verify that the ChatGPT plugin connection was successfully added inside ChatGPT, because that final connection step is performed by the user in ChatGPT and is outside the local application's authority.
