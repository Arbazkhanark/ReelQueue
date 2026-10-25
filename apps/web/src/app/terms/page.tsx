
import type { Metadata } from "next";
import LegalPage from "@/components/legal-page";

export const metadata: Metadata = {
  title: "Terms of Service | ReelQueue",
  description:
    "Read the terms governing your use of ReelQueue's scheduling and publishing service.",
};

export default function TermsPage() {
  return (
    <LegalPage
      label="Service agreement"
      title="Clear rules. Better publishing."
      description="These terms explain the responsibilities and limitations that apply when you use ReelQueue."
      lastUpdated="October 25, 2026"
      sections={[
        {
          title: "Acceptance of these terms",
          paragraphs: [
            "By accessing or using ReelQueue, you agree to these Terms of Service. If you do not agree, do not use the service.",
            "If you use ReelQueue on behalf of an organization, you confirm that you are authorized to accept these terms on its behalf.",
          ],
        },
        {
          title: "What ReelQueue provides",
          paragraphs: [
            "ReelQueue provides tools for managing media and scheduling supported social-media publishing workflows. Features may include account connections, media storage, scheduling, job processing, and publishing-status information.",
            "Features may change as the service develops. We do not guarantee uninterrupted availability or that every feature will always be available.",
          ],
        },
        {
          title: "Your account",
          paragraphs: [
            "You are responsible for providing accurate account information, safeguarding your credentials, and activity performed through your account.",
            "You must notify us if you suspect unauthorized access. We may restrict access when reasonably necessary to protect users, the service, or third-party systems.",
          ],
        },
        {
          title: "Connected accounts and authorization",
          paragraphs: [
            "You must have the right to connect each Instagram, Google Drive, or other supported account you use with ReelQueue.",
            "You authorize ReelQueue to perform the operations you request within the permissions granted to the application. You may disconnect an integration or revoke its permissions, but related features may stop working.",
            "Third-party platforms may change their APIs, permissions, eligibility requirements, or policies. ReelQueue cannot guarantee that an integration will remain available or behave identically over time.",
          ],
        },
        {
          title: "Content ownership and responsibility",
          paragraphs: [
            "You retain responsibility for the media and other content you submit through ReelQueue. You must own the content or have the permissions and licenses required to upload, store, schedule, and publish it.",
            "You are responsible for ensuring your content complies with applicable law and the rules of the platforms where it is published. Do not use ReelQueue to infringe intellectual-property rights, violate privacy, distribute unlawful content, or abuse third-party services.",
            "You must review your content, captions, selected account, and scheduled time before initiating publication.",
          ],
        },
        {
          title: "Scheduling and publishing",
          paragraphs: [
            "Scheduling a post creates a request for publication; it is not a guarantee that the post will be published at an exact time or at all.",
            "Publishing may be delayed or fail because of platform availability, API limits, account restrictions, media requirements, network errors, expired authorization, processing delays, or other circumstances outside our control.",
            "You are responsible for monitoring job status and resolving issues with your connected accounts. Avoid repeatedly submitting the same content when a previous publishing attempt has an uncertain result, because duplicate publication may occur.",
          ],
        },
        {
          title: "Acceptable use",
          paragraphs: [
            "You agree not to misuse, disrupt, reverse engineer, or attempt to gain unauthorized access to ReelQueue or its infrastructure, except where applicable law permits such activity.",
            "You must not use the service for spam, deceptive activity, unauthorized access, malicious content, or activity that violates the policies of connected platforms.",
            "We may investigate suspected abuse and suspend or restrict access when reasonably necessary to protect the service, users, or third parties.",
          ],
        },
        {
          title: "Third-party services",
          paragraphs: [
            "ReelQueue may depend on services operated by Meta, Google, hosting providers, storage providers, database providers, and other third parties.",
            "Those services are governed by their own terms and policies. ReelQueue is not responsible for outages, policy changes, account decisions, or actions taken by third-party providers.",
            "ReelQueue is an independent service and is not endorsed by or affiliated with Meta or Google unless explicitly stated otherwise.",
          ],
        },
        {
          title: "Availability and limitations",
          paragraphs: [
            "We work to keep ReelQueue available, but maintenance, infrastructure failures, network issues, and other events may cause interruptions or data-processing delays.",
            "To the extent permitted by law, ReelQueue is provided on an 'as available' basis without a guarantee that the service will be uninterrupted, error-free, or suitable for every particular purpose.",
          ],
        },
        {
          title: "Suspension and termination",
          paragraphs: [
            "You may stop using ReelQueue at any time and request account deletion by contacting arbaaazkhanark23@gmail.com.",
            "We may suspend or terminate access when necessary to address violations of these terms, security risks, legal obligations, or material abuse of the service.",
            "Termination may affect pending jobs, scheduled posts, connected accounts, and access to stored information. You should review pending publishing jobs before disconnecting an account or ending use of the service.",
          ],
        },
        {
          title: "Changes to these terms",
          paragraphs: [
            "We may update these terms as ReelQueue evolves or legal requirements change. Updated terms will be published on this page with a revised date. Continued use after changes take effect constitutes acceptance where permitted by law.",
          ],
        },
        {
          title: "Applicable law",
          paragraphs: [
            "These terms are subject to applicable laws. Any governing-law or dispute-resolution provisions will be determined in accordance with the laws applicable to the service and the parties involved.",
          ],
        },
        {
          title: "Contact",
          paragraphs: [
            "For questions about these terms or the service, contact arbaaazkhanark23@gmail.com.",
          ],
        },
      ]}
    />
  );
}
