
import type { Metadata } from "next";
import LegalPage from "@/components/legal-page";

export const metadata: Metadata = {
  title: "Privacy Policy | ReelQueue",
  description:
    "Learn how ReelQueue handles account information, connected services, media, and privacy requests.",
};

export default function PrivacyPage() {
  return (
    <LegalPage
      label="Privacy & data"
      title="Your content. Your accounts. Your control."
      description="This policy explains how ReelQueue handles information when you use our scheduling and publishing service."
      lastUpdated="October 25, 2026"
      sections={[
        {
          title: "Who we are",
          paragraphs: [
            "ReelQueue is a service designed to help users manage media and schedule publishing workflows for supported social platforms. For questions about this policy or your personal information, contact arbaaazkhanark23@gmail.com.",
          ],
        },
        {
          title: "Information we handle",
          paragraphs: [
            "Depending on the features you use, ReelQueue may process account details such as your name and email address, authentication information, connected-account identifiers, scheduling preferences, and service activity.",
            "When you upload or select media, we process the files and related information needed to store, prepare, schedule, and attempt publication of that content.",
          ],
          bullets: [
            "Account and profile information you provide.",
            "Scheduling details, job status, and operational logs.",
            "Media files and metadata required for your publishing workflow.",
            "Information returned by connected services when you authorize access.",
          ],
        },
        {
          title: "Instagram and Meta",
          paragraphs: [
            "If you connect an Instagram account, ReelQueue uses the permissions you authorize to access supported account information and perform supported publishing operations through Meta's APIs.",
            "We use connected-account information to support the features you request, such as account connection and media publishing. Availability depends on your account, granted permissions, Meta's policies, and API limits.",
            "ReelQueue does not control Meta's own handling of your information. Review Meta's privacy policy and the permissions shown during authorization for more details.",
          ],
        },
        {
          title: "Google Drive access",
          paragraphs: [
            "If you connect Google Drive, ReelQueue requests the Google Drive access scope configured for the application. The current integration is designed around the drive.file scope, which provides access to files created by the app or files you choose to make available to it.",
            "Drive access is used to support the file-selection and media workflow you request. We do not claim access to every file in your Google Drive through this limited scope.",
            "You can revoke ReelQueue's Google access through your Google Account's third-party connections settings. Revoking access may prevent Drive-related features from working.",
          ],
        },
        {
          title: "How we use information",
          paragraphs: [
            "We use information to provide the service, authenticate users, connect authorized accounts, store and process media, schedule and attempt publishing, troubleshoot errors, protect accounts, and maintain the reliability and security of ReelQueue.",
            "We do not use your connected accounts to publish content without a request or workflow initiated through the service.",
          ],
        },
        {
          title: "Storage and service providers",
          paragraphs: [
            "ReelQueue relies on infrastructure and third-party providers for functions such as database storage, job queues, media storage, hosting, email delivery, and integrations with social platforms.",
            "Information may be processed by these providers only as needed to operate the service, subject to their applicable terms and privacy practices. The exact provider and storage location may change as the service evolves.",
          ],
        },
        {
          title: "Security",
          paragraphs: [
            "ReelQueue uses technical measures intended to protect accounts and information, including authentication controls and protected handling of connected-account credentials. No internet service or storage system can guarantee absolute security.",
            "Please keep your login credentials private and contact us if you believe your account has been accessed without permission.",
          ],
        },
        {
          title: "Retention and deletion",
          paragraphs: [
            "Information is retained for as long as reasonably necessary to provide the service, maintain account security, process scheduled jobs, resolve disputes, and meet applicable legal obligations. Retention periods may vary by data type and operational requirement.",
            "You may request account or personal-data deletion by emailing arbaaazkhanark23@gmail.com. We will review the request and explain any information that must be retained for legitimate operational or legal reasons.",
            "Deleting information from ReelQueue does not necessarily delete copies held by third-party services, including Google, Meta, or files you previously uploaded to external storage. Those services may need to be managed separately.",
          ],
        },
        {
          title: "Your choices and rights",
          paragraphs: [
            "Depending on your location and applicable law, you may have rights to access, correct, export, or request deletion of your personal information, and to withdraw consent for optional integrations.",
            "You can disconnect authorized services through the relevant provider's account settings. You may also contact us with privacy questions or requests.",
          ],
        },
        {
          title: "Children's privacy",
          paragraphs: [
            "ReelQueue is not intended for children who are not legally permitted to use the service. We do not knowingly collect personal information from children in violation of applicable law.",
          ],
        },
        {
          title: "Changes to this policy",
          paragraphs: [
            "We may update this policy when our features, providers, or legal obligations change. The revised policy will be published on this page with an updated revision date.",
          ],
        },
        {
          title: "Contact",
          paragraphs: [
            "For privacy questions, access requests, or deletion requests, contact arbaaazkhanark23@gmail.com.",
          ],
        },
      ]}
    />
  );
}
