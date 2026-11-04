import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobFromEmail, companyFromSender } from '../src/autojob.js';
import { classify } from '../src/classify.js';

// Classify like the Worker does, then build the job.
function auto(email) {
  const { category } = classify(email);
  return { category, job: jobFromEmail(email, category) };
}

test('companyFromSender strips recruiting words', () => {
  assert.equal(companyFromSender('Stripe Recruiting'), 'Stripe');
  assert.equal(companyFromSender('Capital One Careers'), 'Capital One');
  assert.equal(companyFromSender('Ramp Hiring Team'), 'Ramp');
  assert.equal(companyFromSender('Jane at Figma'), 'Figma');
  assert.equal(companyFromSender('Datadog via Greenhouse'), 'Datadog');
  assert.equal(companyFromSender('Talent Acquisition - Uber'), 'Uber');
  assert.equal(companyFromSender('Workday'), null);
  assert.equal(companyFromSender('no-reply'), null);
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
