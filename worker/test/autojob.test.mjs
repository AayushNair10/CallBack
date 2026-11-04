import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobFromEmail, companyFromSender, cleanRole } from '../src/autojob.js';
import { classify } from '../src/classify.js';

// Classify like the Worker does, then build the job.
function auto(email) {
  const { category } = classify(email);
  return { category, job: jobFromEmail(email, category) };
}

test('companyFromSender strips recruiting words', () => {
  const name = (s) => companyFromSender(s)?.name ?? null;
  assert.equal(name('Stripe Recruiting'), 'Stripe');
  assert.equal(name('Capital One Careers'), 'Capital One');
  assert.equal(name('Ramp Hiring Team'), 'Ramp');
  assert.equal(name('Jane at Figma'), 'Figma');
  assert.equal(name('Datadog via Greenhouse'), 'Datadog');
  assert.equal(name('Talent Acquisition - Uber'), 'Uber');
  assert.equal(name('Workday'), null);
  assert.equal(name('no-reply'), null);
  // From a real inbox:
  assert.equal(name('workday. paypal'), 'paypal');
  assert.equal(name('workday- f5'), 'f5');
  assert.equal(name('Workday Nordstrom'), 'Nordstrom');
  assert.equal(name('WorkdaySystemDoNotReply'), null);
  assert.equal(name('Early Careers at Wise'), 'Wise');
  assert.equal(companyFromSender('Erica Saunders').org, false);
});

test('LinkedIn "application was sent" email', () => {
  const { category, job } = auto({
    from_name: 'LinkedIn', from_addr: 'jobs-noreply@linkedin.com', from_domain: 'linkedin.com',
    subject: 'Aayush, your application was sent to Meta',
    body: 'Your application was sent to Meta\n\nSoftware Engineer, Infrastructure\nMeta · Menlo Park, CA (On-site)\nApplied on November 3, 2026\n\nView job: https://www.linkedin.com/comm/jobs/view/4012345678/?trackingId=abc',
    list_unsubscribe: true,
  });
  assert.equal(category, 'application_received');
  assert.deepEqual(job, {
    company: 'Meta',
    role: 'Software Engineer, Infrastructure',
    location: 'Menlo Park, CA (On-site)',
    url: 'https://www.linkedin.com/jobs/view/4012345678/',
    aliases: ['meta'],
  });
});

test('Greenhouse confirmation names company and role', () => {
  const { job } = auto({
    from_name: 'Stripe Recruiting', from_addr: 'no-reply@us.greenhouse-mail.io', from_domain: 'us.greenhouse-mail.io',
    subject: 'Thank you for applying to Stripe',
    body: "Hi Aayush,\n\nThanks for applying for the Backend Engineer, Payments position at Stripe. We've received your application.\n\nhttps://boards.greenhouse.io/stripe/jobs/6012345?gh_jid=6012345&utm=x",
  });
  assert.equal(job.company, 'Stripe');
  assert.equal(job.role, 'Backend Engineer, Payments');
  assert.equal(job.url, 'https://boards.greenhouse.io/stripe/jobs/6012345?gh_jid=6012345');
  assert.deepEqual(job.aliases, ['stripe']);
});

test('Workday confirmation falls back to the tenant in the address', () => {
  const { category, job } = auto({
    from_name: 'Workday', from_addr: 'capitalone@myworkday.com', from_domain: 'myworkday.com',
    subject: 'Thank you for applying!',
    body: 'We have received your application for Software Engineer, Early Career. Our team will review it.',
  });
  assert.equal(category, 'application_received');
  assert.equal(job.company, 'Capitalone');
  assert.equal(job.role, 'Software Engineer, Early Career');
});

test('company-domain confirmation uses the sender name that agrees with the domain', () => {
  const { job } = auto({
    from_name: 'Capital One Careers', from_addr: 'careers@capitalone.com', from_domain: 'capitalone.com',
    subject: 'Application received',
    body: 'Thank you for your interest in Capital One. We have received your application for the Data Analyst role.',
  });
  assert.equal(job.company, 'Capital One');
  assert.equal(job.role, 'Data Analyst');
  assert.deepEqual(job.aliases, ['capital one', 'capitalone']);
});

test('rejection for an untracked application creates a job', () => {
  const { category, job } = auto({
    from_name: 'Airbnb', from_addr: 'no-reply@ashbyhq.com', from_domain: 'ashbyhq.com',
    subject: 'Your application to Airbnb',
    body: 'Thank you for applying. Unfortunately we have decided to move forward with other candidates.',
  });
  assert.equal(category, 'rejection');
  assert.equal(job.company, 'Airbnb');
});

test('OA platform invite names the company in the subject', () => {
  const { category, job } = auto({
    from_name: 'HackerRank', from_addr: 'support@hackerrank.com', from_domain: 'hackerrank.com',
    subject: 'Datadog has invited you to take a test',
    body: 'You have been invited to take the Datadog Software Engineer test. https://www.hackerrank.com/test/abc',
  });
  assert.equal(category, 'oa');
  assert.equal(job.company, 'Datadog');
});

test('does not create jobs from noise, free mail, spam or cold interview mail', () => {
  // Job alert.
  assert.equal(auto({ from_name: 'LinkedIn', from_domain: 'linkedin.com', subject: 'Stripe - Software Engineer and 10 more jobs', body: 'New jobs', list_unsubscribe: true }).job, null);
  // Free mail.
  assert.equal(jobFromEmail({ from_name: 'Bob', from_domain: 'gmail.com', subject: 'Thanks for applying to Acme', body: '' }, 'application_received'), null);
  // Unknown sender in Spam.
  assert.equal(jobFromEmail({ from_name: 'HR', from_domain: 'weird.biz', subject: 'Thank you for applying to Weird', body: '', in_spam: true }, 'application_received'), null);
  // Interview from a company domain that never mentions an application.
  assert.equal(jobFromEmail({ from_name: 'Jane at Acme', from_domain: 'acme.com', subject: 'Interview invitation', body: 'We would like to schedule an interview.' }, 'interview'), null);
  // Categories that don't change status.
  assert.equal(jobFromEmail({ from_name: 'Stripe', from_domain: 'stripe.com', subject: 'Hello', body: '' }, 'other'), null);
});

test('cleanRole keeps job titles and rejects sentence fragments (real inbox cases)', () => {
  const cases = [
    ['AI Product Engineer / Forward Deployed Engineer job was submitted successfully', 'AI Product Engineer / Forward Deployed Engineer'],
    ['Software Development Engineer job was submitted successfully', 'Software Development Engineer'],
    ['apply to the Software Engineering, New Grad', 'Software Engineering, New Grad'],
    ['taking the time and effort to apply for the Graduate Software Engineer', 'Graduate Software Engineer'],
    ['apply for the Working in Technology (WiT) Software Engineering - Summer 2027', 'Working in Technology (WiT) Software Engineering - Summer 2027'],
    ['* Backend Developer', 'Backend Developer'],
    ['Full Stack Software Workflow Engineer (PHP) - 69247', 'Full Stack Software Workflow Engineer (PHP)'],
    ['Software Engineer, New Grad (Dec 2026)', 'Software Engineer, New Grad (Dec 2026)'],
    ['Software Engineer - New Grad 2026', 'Software Engineer - New Grad 2026'],
    ['Data Analyst R123456', 'Data Analyst'],
    ['more information and support on the recruitment stages visit: Graduate and', null],
    ['proceed with your candidacy for the current', null],
    ['let you know that you were not selected for the', null],
    ['determine if there is alignment with the current', null],
    ['in this', null],
    ['R172018 2027 University', null],
  ];
  for (const [input, want] of cases) assert.equal(cleanRole(input), want, input);
});

test('real-inbox company cases', () => {
  // Workday sender names with the tenant baked in, casing taken from the email.
  let job = jobFromEmail({ from_name: 'workday. paypal', from_addr: 'paypal@myworkday.com', from_domain: 'myworkday.com',
    subject: 'Update on your application', body: 'Thank you for your interest in PayPal. Unfortunately we will not be moving forward.' }, 'rejection');
  assert.equal(job.company, 'PayPal');
  job = jobFromEmail({ from_name: 'workday- f5', from_addr: 'f5@myworkday.com', from_domain: 'myworkday.com',
    subject: 'Thank you for applying', body: 'We received your application.' }, 'application_received');
  assert.equal(job.company, 'F5');
  assert.deepEqual(job.aliases, ['f5']);
  // A recruiter's own name is not the company.
  job = jobFromEmail({ from_name: 'Erica Saunders', from_addr: 'no-reply@ashbyhq.com', from_domain: 'ashbyhq.com',
    subject: 'Following up on your application', body: 'Thank you for applying to Meow. We have decided to move forward with other candidates.\n\nBest,\nErica Saunders' }, 'rejection');
  assert.equal(job.company, 'Meow');
  job = jobFromEmail({ from_name: 'Erica Saunders', from_addr: 'no-reply@ashbyhq.com', from_domain: 'ashbyhq.com',
    subject: 'Following up', body: 'Unfortunately we will not be moving forward.\n\nBest,\nErica Saunders' }, 'rejection');
  assert.equal(job, null, 'no company found -> no job rather than a person name');
  // Possessive.
  job = jobFromEmail({ from_name: 'Notion', from_addr: 'no-reply@ashbyhq.com', from_domain: 'ashbyhq.com',
    subject: 'Your application', body: "Thank you for your interest in Notion's Software Engineer, New Grad (Dec 2026) role." }, 'rejection');
  assert.equal(job.company, 'Notion');
  // Domain-looking sender name.
  job = jobFromEmail({ from_name: 'Careers @ .questdiagnostics.com', from_addr: 'careers@questdiagnostics.com', from_domain: 'questdiagnostics.com',
    subject: 'Thank you for applying', body: 'We received your application.' }, 'application_received');
  assert.equal(job.company, 'Questdiagnostics');
});
