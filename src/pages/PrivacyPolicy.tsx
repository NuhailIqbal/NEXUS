import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Link } from "react-router-dom";

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
          <Section id="intro" title="1. Introduction and Scope">
            <p>
              This Privacy Policy (the "Policy") describes how EDM Nexus ("the Company," "we,"
              "us," or "our") collects, uses, discloses, and safeguards information in connection
              with its AI voice calling platform, accessible at edmnexus.ai, including the
              dashboard, the AI voice agents configured through it, and associated websites
              (collectively, the "Service").
            </p>
            <p>
              This Policy distinguishes between two categories of information. Information
              relating to a registered user of the Service (a "Customer") and their account is
              processed by the Company as a controller. Information relating to a Customer's own
              contacts and the individuals reached or answered by a Customer's AI voice agents
              ("Call Data" and "Contact Data") is processed by the Company as a processor, strictly
              on the Customer's instructions and for the purposes the Customer configures. The
              Customer remains responsible for the lawfulness of that processing, as described
              further in Section 3.
            </p>
          </Section>

          <Section id="collect" title="2. Information We Collect">
            <p>
              <strong className="text-foreground">Account Information.</strong> Name, email
              address, company name, and password. Passwords are stored only as an irreversible
              cryptographic hash and are never retained in plain text.
            </p>
            <p>
              <strong className="text-foreground">Billing Information.</strong> Wallet balance,
              top-up history, promotional credit, and per-call charges. Payment card details are
              submitted directly to the Company's payment processor and are never transmitted to
              or stored on Company servers. The Company retains only a reference identifier
              together with the card brand, last four digits, and expiration date for display
              purposes.
            </p>
            <p>
              <strong className="text-foreground">Contact Data.</strong> Names, telephone numbers,
              email addresses, list assignments, and any custom fields configured by the Customer,
              including a consent-tracking field where used.
            </p>
            <p>
              <strong className="text-foreground">Call Data.</strong> For each call placed or
              received by a Customer's AI voice agent, the Company records the telephone numbers
              involved, the time and duration of the call, its outcome, its cost, an{" "}
              <strong className="text-foreground">audio recording</strong>, a{" "}
              <strong className="text-foreground">written transcript</strong>, and an
              AI-generated summary. See Section 3.
            </p>
            <p>
              <strong className="text-foreground">Technical Information.</strong> Server logs,
              including IP address and request metadata, retained for security monitoring and
              diagnostic purposes.
            </p>
          </Section>

          <Section id="recording" title="3. Call Recording and Transcription">
            <p className="text-foreground">
              Every call placed or answered by an AI voice agent on the Service is recorded and
              transcribed by default.
            </p>
            <p>
              The recording of telephone calls is subject to regulation that varies by
              jurisdiction. Certain jurisdictions, including a number of U.S. states, require the
              consent of all parties to a call prior to recording. Automated and prerecorded
              outbound calls are separately regulated in the United States under the Telephone
              Consumer Protection Act ("TCPA"), and certain jurisdictions additionally require
              disclosure that a caller is an automated system rather than a natural person.
            </p>
            <p>
              As the Customer determines who its agents contact and what those agents
              communicate, the Customer is solely responsible for compliance with all applicable
              recording-consent, telemarketing, and AI-disclosure laws, including obtaining any
              consent required, honoring do-not-call requests, observing permitted calling hours,
              and disclosing the use of recording and artificial intelligence where legally
              required. Configuring the agent to make such disclosures in its opening statement is
              one practical means of satisfying this obligation.
            </p>
            <p>
              Customers may review or delete individual call records from the dashboard at any
              time.
            </p>
          </Section>

          <Section id="use" title="4. How We Use Information">
            <p>
              The Company uses the information described above to: operate Customer accounts and
              place and receive calls; generate recordings, transcripts, and summaries for
              Customer review; calculate call costs and process billing; deliver service
              communications, including email verification and low-balance notifications; provide
              customer support; detect and prevent misuse of the Service; and comply with
              applicable legal obligations.
            </p>
            <p>
              The Company does not sell personal information and does not use call recordings,
              transcripts, or Contact Data to advertise to Customers or the individuals they
              contact.
            </p>
          </Section>

          <Section id="subprocessors" title="5. Disclosure to Service Providers">
            <p>
              The Company engages a limited number of trusted third-party service providers to
              operate the Service, including providers of voice and telephony infrastructure,
              speech transcription, cloud computing and hosting, payment processing, and
              transactional email delivery. These providers receive only the information necessary
              to perform their function and are contractually bound to use it solely for that
              purpose.
            </p>
            <p>
              Payment card information is collected and stored exclusively by the Company's
              payment processor and is never transmitted to or held on Company servers.
            </p>
            <p>
              Each provider processes data under its own terms of service and privacy policy and
              may process data outside the Customer's country of residence. The Company may also
              disclose information where required by law, legal process, or governmental request,
              or where necessary to protect the rights, property, or safety of the Company, its
              users, or the public.
            </p>
          </Section>

          <Section id="retention" title="6. Data Retention">
            <p>
              Account, billing, and call records are retained for as long as the associated
              account remains active, for the Customer's own reference and for the Company's tax
              and accounting purposes. Customers may delete individual contacts and call records
              at any time through the dashboard.
            </p>
            <p>
              Upon account closure, the Company deletes Customer data except where retention of
              transaction records is required by applicable law or accounting standards.
            </p>
          </Section>

          <Section id="rights" title="7. Your Rights and Choices">
            <p>
              Customers may access and correct their account information through the dashboard,
              and may request deletion of their account and associated data at any time.
            </p>
            <p>
              <strong className="text-foreground">California Residents.</strong> Under the
              California Consumer Privacy Act and California Privacy Rights Act, California
              residents may request access to, deletion of, or correction of the personal
              information the Company holds about them, and may request disclosure of the
              categories of information collected and shared. The Company does not sell personal
              information and does not share personal information for cross-context behavioral
              advertising. The Company will not discriminate against any individual for exercising
              these rights.
            </p>
            <p>
              <strong className="text-foreground">Users in the United Kingdom and European
              Economic Area.</strong> Where the General Data Protection Regulation applies, data
              subjects additionally have the right to object to or restrict processing, the right
              to data portability, and the right to lodge a complaint with their local supervisory
              authority. The Company's processing is based on the performance of its contract with
              the Customer, its legitimate interests in maintaining the security and integrity of
              the Service, and consent where consent is obtained.
            </p>
            <p>Requests may be submitted using the contact details in Section 11.</p>
          </Section>

          <Section id="security" title="8. Data Security">
            <p>
              Data transmitted to and from the Service is encrypted in transit. Passwords are
              stored only as cryptographic hashes, access to account data requires authentication,
              and payment card details are handled exclusively by the Company's payment processor
              and are never transmitted to or stored on Company infrastructure.
            </p>
            <p>
              The Company does not currently hold a SOC 2, ISO 27001, or HIPAA attestation, and
              the Service is not intended for the collection or processing of protected health
              information. No method of transmission or storage is guaranteed to be entirely
              secure, and the Company cannot warrant absolute security.
            </p>
          </Section>

          <Section id="cookies" title="9. Cookies and Local Storage">
            <p>
              The Service uses browser local storage to retain an authentication token and a
              display theme preference, both of which are strictly necessary for the Service to
              function. The Company does not use advertising or cross-site tracking cookies.
            </p>
          </Section>

          <Section id="children" title="10. Children's Privacy">
            <p>
              The Service is intended for business use and is not directed to, nor intended for
              use by, individuals under the age of 18. The Company does not knowingly collect
              personal information from children. Any person who becomes aware that a child has
              provided personal information to the Company should contact us, and the information
              will be deleted.
            </p>
          </Section>

          <Section id="contact" title="11. Contact Information">
            <p>
              Questions regarding this Policy, or requests to exercise the rights described
              herein, including access and deletion requests, may be directed to:
            </p>
            <p className="text-foreground">
              Email:{" "}
              <a href="mailto:info@edmnexus.ai" className="text-primary hover:underline">
                info@edmnexus.ai
              </a>
            </p>
            <p className="text-xs text-muted-foreground/80 italic">
              The registered legal entity name, principal place of business, and governing
              jurisdiction of the Company will be included here upon finalization of the Company's
              corporate registration details.
            </p>
          </Section>

          <Section id="changes" title="12. Changes to This Policy">
            <p>
              The Company may revise this Policy from time to time. Where a revision materially
              affects the manner in which Customer information is handled, the Company will
              provide direct notice to affected Customers in advance of the change taking effect.
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
