import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Link } from "react-router-dom";

// Third parties that actually receive data, taken from the services the platform calls.
const subprocessors = [
  {
    name: "Vapi",
    purpose: "Runs the voice agent during a call; generates and stores call recordings and transcripts",
    data: "Call audio, transcripts, phone numbers, call metadata",
  },
  {
    name: "Twilio",
    purpose: "Supplies phone numbers and carries the actual phone call",
    data: "Phone numbers, call times and durations",
  },
  {
    name: "OpenAI",
    purpose: "Powers the agent's side of the conversation",
    data: "Conversation text, your agent's instructions and knowledge content",
  },
  {
    name: "Deepgram",
    purpose: "Converts speech to text so the call can be transcribed",
    data: "Call audio",
  },
  {
    name: "Google (Gemini)",
    purpose: "Produces the post-call summary and sentiment read-out",
    data: "Call transcript text",
  },
  {
    name: "Stripe",
    purpose: "Processes payments and stores your card securely",
    data: "Name, email, billing details, card data (handled entirely by Stripe)",
  },
  {
    name: "Brevo",
    purpose: "Sends email on your behalf, where you have connected it",
    data: "Recipient email addresses and message content",
  },
  {
    name: "Google (Gmail SMTP)",
    purpose: "Sends our own service emails, such as email verification",
    data: "Your email address",
  },
];

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className="text-xl font-bold text-foreground">{title}</h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted-foreground">{children}</div>
    </section>
  );
}

const PrivacyPolicy = () => (
  <div className="min-h-screen bg-background">
    <Navbar />

    <section className="relative pt-32 pb-20 overflow-hidden">
      <div className="absolute inset-0 grid-pattern opacity-20 pointer-events-none" />
      <div className="container mx-auto px-4 relative z-10 max-w-3xl">
        <h1 className="text-4xl md:text-5xl font-bold">Privacy Policy</h1>

        <div className="mt-12 space-y-10">
          <Section id="intro" title="1. Who this covers">
            <p>
              This policy explains how EDM Nexus ("we", "us") handles personal information when you
              use our AI voice calling platform at edmnexus.ai, including the dashboard, the phone
              agents you build, and our website.
            </p>
            <p>
              There are two different roles to keep in mind. For your own account information, we
              decide how the data is used. For the contact data you upload and the people your
              agents call, <strong className="text-foreground">you</strong> decide how that data is
              used and we simply process it on your instructions.
            </p>
          </Section>

          <Section id="collect" title="2. What we collect">
            <p><strong className="text-foreground">Account information.</strong> Your name, email
              address, company name, and password (stored only as a secure hash).</p>
            <p><strong className="text-foreground">Billing information.</strong> Your wallet
              balance, top-ups, promotional credit, and per-call charges. Card details are entered
              directly with Stripe and never reach our servers. We only keep an identifier plus the
              card brand, last four digits and expiry so you can recognise it.</p>
            <p><strong className="text-foreground">Contact data you upload.</strong> Names, phone
              numbers, email addresses, list membership and any custom fields you create, including
              a consent field if you use it.</p>
            <p><strong className="text-foreground">Call data.</strong> For every call your agents
              make or answer we store the phone numbers involved, the time and duration, the
              outcome, the cost, an{" "}
              <strong className="text-foreground">audio recording</strong>, a{" "}
              <strong className="text-foreground">written transcript</strong> and an AI-generated
              summary. See section 3.</p>
            <p><strong className="text-foreground">Technical information.</strong> Server logs
              including IP address and request details, kept for security and debugging.</p>
          </Section>

          <Section id="recording" title="3. Call recording and transcription (please read)">
            <p className="text-foreground">
              Every call placed or answered by an agent on this platform is recorded and
              transcribed by default.
            </p>
            <p>
              Recording a phone call is regulated, and the rules differ by country and by US state.
              Several states require the consent of <em>everyone</em> on the call before it can be
              recorded. Automated and pre-recorded outbound calls are separately regulated in the
              United States under the TCPA, and some jurisdictions now also require you to disclose
              that the caller is an AI rather than a person.
            </p>
            <p>
              Because you control who your agents call and what they say, you are responsible for
              meeting those obligations, including getting whatever consent is required, honouring
              do-not-call requests, respecting calling hours, and disclosing recording and the use
              of AI where the law requires it. A practical way to handle this is to have your agent
              say so in its opening line.
            </p>
            <p>
              You can review or delete individual call records from your dashboard at any time.
            </p>
          </Section>

          <Section id="use" title="4. How we use information">
            <p>We use the information above to operate your account and place and receive calls; to
              generate recordings, transcripts and summaries so you can review calls; to calculate
              what each call cost and bill your balance; to send service emails such as email
              verification and low-balance alerts; to provide support; to detect abuse and protect
              the platform; and to meet our legal obligations.</p>
            <p>
              We do not sell your personal information, and we do not use your call recordings,
              transcripts or contact lists to advertise to you.
            </p>
          </Section>

          <Section id="subprocessors" title="5. Who else receives data">
            <p>
              Running a phone call requires several specialist providers. These are the third
              parties that receive data, and why:
            </p>
            <div className="mt-4 overflow-hidden rounded-xl border border-border">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-muted/50 uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3">Provider</th>
                      <th className="px-4 py-3">Why</th>
                      <th className="px-4 py-3">What they receive</th>
                    </tr>
                  </thead>
                  <tbody>
                    {subprocessors.map((s) => (
                      <tr key={s.name} className="border-t border-border">
                        <td className="px-4 py-3 font-medium text-foreground">{s.name}</td>
                        <td className="px-4 py-3">{s.purpose}</td>
                        <td className="px-4 py-3">{s.data}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <p className="mt-4">
              These providers operate under their own terms and may process data outside your
              country. We may also disclose information if we are legally required to, or to
              protect our rights or someone's safety.
            </p>
          </Section>

          <Section id="retention" title="6. How long we keep it">
            <p>
              Account, billing and call records are kept for as long as your account is open,
              because you need them for your own records and we need them for tax and accounting
              purposes. You can delete individual contacts and call records yourself at any time.
            </p>
            <p>
              If you close your account we delete your data, except where we are required to retain
              transaction records for legal or accounting reasons.
            </p>
          </Section>

          <Section id="rights" title="7. Your rights">
            <p>
              You can access and correct your account details in the dashboard, and you can ask us
              to delete your account and its data.
            </p>
            <p>
              <strong className="text-foreground">California residents.</strong> Under the CCPA and
              CPRA you may request access to the personal information we hold about you, request its
              deletion or correction, and ask us to disclose what we collect and share. We do not
              sell personal information or share it for cross-context behavioural advertising, and
              we will not discriminate against you for exercising these rights.
            </p>
            <p>
              <strong className="text-foreground">Visitors in the UK and EEA.</strong> Where the
              GDPR applies to you, you also have rights to object to or restrict processing, to data
              portability, and to lodge a complaint with your local supervisory authority. We rely
              on performing our contract with you to run your account, on our legitimate interests
              to keep the platform secure, and on consent where we ask for it.
            </p>
            <p>To make a request, email us using the contact details in section 11.</p>
          </Section>

          <Section id="security" title="8. Security">
            <p>
              Traffic to the platform is encrypted in transit. Passwords are stored only as
              hashes, access to your data requires your login, and payment card details are handled
              entirely by Stripe so they never reach our systems.
            </p>
            <p>
              We do not currently hold a SOC 2, ISO 27001 or HIPAA attestation, and the platform is
              not intended for protected health information. No system is perfectly secure, so we
              cannot guarantee absolute security.
            </p>
          </Section>

          <Section id="cookies" title="9. Cookies and local storage">
            <p>
              We keep this deliberately minimal. The site stores your login token and your
              light/dark theme preference in your browser's local storage. These are needed for the
              product to work. We do not use advertising or cross-site tracking cookies.
            </p>
          </Section>

          <Section id="children" title="10. Children">
            <p>
              The platform is for business use and is not intended for anyone under 18. We do not
              knowingly collect information from children. If you believe a child has given us
              information, contact us and we will delete it.
            </p>
          </Section>

          <Section id="contact" title="11. Contact us">
            <p>
              For any privacy question or request, including access and deletion:
            </p>
            <p className="text-foreground">
              Email:{" "}
              <a href="mailto:info@edmnexus.ai" className="text-primary hover:underline">
                info@edmnexus.ai
              </a>
            </p>
            <p className="rounded-lg border border-dashed border-border bg-secondary/40 p-3 text-xs">
              <strong className="text-foreground">To be completed before publishing:</strong> the
              full legal entity name and registered postal address of the company operating EDM
              Nexus, and the governing state for any disputes.
            </p>
          </Section>

          <Section id="changes" title="12. Changes to this policy">
            <p>
              We may update this policy from time to time. If a change materially affects how we
              handle your information, we will tell you directly.
            </p>
          </Section>
        </div>

        <div className="mt-14 border-t border-border pt-6 text-sm text-muted-foreground">
          Questions about the product instead?{" "}
          <Link to="/request-access" className="text-primary hover:underline">Get in touch</Link>.
        </div>
      </div>
    </section>

    <Footer />
  </div>
);

export default PrivacyPolicy;
