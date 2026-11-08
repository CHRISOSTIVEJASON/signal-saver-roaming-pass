# Welcome to your Lovable project

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Open your project in the [Lovable editor](https://lovable.dev) and keep building.

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: connect the project to GitHub and every change made in Lovable is committed straight to your repository.
- **Full ownership**: this code is yours. Push to your repository and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```

## Built with

- TanStack Start
- TypeScript
- React
- Tailwind CSS

## Android export

This is a native shell for the hosted TanStack application, not an offline static export.
Publish the web app first. Set GitHub repository Actions variable `CAPACITOR_APP_URL`
to the published HTTPS URL (never the editor preview URL). The `Build Global Networks APK`
workflow synchronizes Capacitor, runs Gradle `assembleDebug`, and uploads an installable
debug APK. Download it from the Actions artifact; upload/host the APK and configure its
HTTPS download link in Settings & APK. Release signing and Play Store delivery are not configured.

The Android plugin performs real Wi-Fi Direct service discovery, P2P negotiation and group
inspection, and Wi-Fi Aware publication on supported hardware. Android chooses the actual
Direct SSID and band; `DIRECT-GLOBAL-NETWORKS` is advertised as service identity. Wi-Fi Aware
data paths and packet forwarding/VPN/proxy transport are **not implemented**. A local P2P
group does not forward internet, so the native plugin deliberately reports `transportReady: false`.
The high-speed client label/countdown eligibility requires a verified transport; it will not
appear just because a local group formed. A foreground notification is required by Android,
so background operation cannot be completely invisible. Native APK compilation and physical
device interoperability have not been verified in this sandbox.

## Shared Cloud records

Pool and APK settings are public reads. Sessions, payments, and native mesh telemetry require
sign-in and are scoped to the account; administrator reads require a protected `user_roles`
row. There is no automatic first-user administrator assignment. Create/sign into your account,
then request administrator assignment for that account. The old browser passcode does not
authorize Cloud access. Existing local demo records and payment credentials are not imported.
Enter PayHero credentials again as an administrator; they are stored server-only and never
returned to browsers. Live PayHero payments require real credentials and a small live test.
Shared signed-in flows remain unverified until an app account exists.
