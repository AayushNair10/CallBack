import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, domainIn, OA_DOMAINS } from '../src/classify.js';
import { slugFromUrl, aliasesFor, companyCore, matchJob, rolesAgree, sameCompany } from '../src/match.js';

const cat = (email) => classify(email).category;

test('domainIn matches exact domains and subdomains only', () => {
  assert.ok(domainIn('hackerrank.com', OA_DOMAINS));
  assert.ok(domainIn('email.hackerrank.com', OA_DOMAINS));
  assert.ok(!domainIn('nothackerrank.com', OA_DOMAINS));
  assert.ok(!domainIn('', OA_DOMAINS));
});

test('OA from hackerrank.com, with link', () => {
  const r = classify({
    from_domain: 'hackerrank.com',
    subject: 'Stripe has invited you to take a test',
    body: 'Hi Aayush,\nYou have been invited to take the Stripe Software Engineer test.\nStart here: https://www.hackerrank.com/test/abc123/login?b=xyz.\nGood luck!',
    list_unsubscribe: true,
  });
  assert.equal(r.category, 'oa');
  assert.equal(r.platform, 'oa');
  assert.equal(r.link, 'https://www.hackerrank.com/test/abc123/login?b=xyz');
});

test('OA from a company domain', () => {
  assert.equal(cat({
    from_domain: 'datadoghq.com',
    subject: 'Next steps: Datadog Online Assessment',
    body: 'Thanks for your interest! Please complete the coding assessment within 7 days.',
  }), 'oa');
});

test('interview from a company domain', () => {
  assert.equal(cat({
    from_domain: 'stripe.com',
    subject: 'Stripe - next steps',
    body: 'We enjoyed reviewing your application and would like to schedule a phone screen. Could you share your availability for next week?',
  }), 'interview');
});

test('interview from calendly.com even with List-Unsubscribe', () => {
  const r = classify({
    from_domain: 'calendly.com',
    subject: 'New Event: Interview with Stripe Recruiting',
    body: 'Your interview has been scheduled. Reschedule: https://calendly.com/reschedulings/abc',
    list_unsubscribe: true,
  });
  assert.equal(r.category, 'interview');
  assert.equal(r.platform, 'scheduling');
  assert.equal(r.link, 'https://calendly.com/reschedulings/abc');
});

test('a confirmation sent through Gem is not an interview', () => {
  const body = 'Hi Aayush,\n\nThank you for your interest in joining our team at Imagen Technologies. We have received your application for Software Engineer. We will reach out soon if there is a potential fit!\n\nBest,\nThe Imagen Technologies Talent Team';
  assert.equal(cat({ from_domain: 'gem.com', subject: 'Thank you for applying to Imagen Technologies', body }), 'application_received');
  assert.equal(cat({ from_domain: 'gem.com', subject: 'Imagen Technologies', body }), 'application_received');
  // A real scheduling email through Gem still is.
  assert.equal(cat({ from_domain: 'gem.com', subject: 'Imagen Technologies: pick a time to chat', body: 'Please select a time for your phone screen with our team.' }), 'interview');
  assert.equal(cat({ from_domain: 'paradox.ai', subject: 'Your interview is confirmed', body: 'See you Tuesday.' }), 'interview');
});

test('rejection from Greenhouse', () => {
  assert.equal(cat({
    from_domain: 'us.greenhouse-mail.io',
    subject: 'Your application to Airbnb',
    body: 'Thank you for your interest in Airbnb. Unfortunately, we have decided to move forward with other candidates whose experience more closely matches our needs.',
  }), 'rejection');
});

test('rejection from Workday', () => {
  assert.equal(cat({
    from_domain: 'myworkday.com',
    subject: 'Update on your application',
    body: 'After careful review, we regret to inform you that we will not be moving forward with your application at this time.',
  }), 'rejection');
});

test('received from Greenhouse', () => {
  assert.equal(cat({
    from_domain: 'greenhouse.io',
    subject: 'Thank you for applying to Figma',
    body: 'We have received your application for Software Engineer, Intern and will review it shortly.',
  }), 'application_received');
});

test('received: LinkedIn "Your application was sent to Meta"', () => {
  assert.equal(cat({
    from_domain: 'linkedin.com',
    subject: 'Aayush, your application was sent to Meta',
    body: 'Your application was sent to Meta. Software Engineer, Meta, Menlo Park, CA. Applied on November 1.',
    list_unsubscribe: true,
  }), 'application_received');
});

test('LinkedIn job alert', () => {
  assert.equal(cat({
    from_domain: 'linkedin.com',
    subject: '"software engineer": Google - Software Engineer and more',
    body: 'Your job alert for software engineer in United States. 30+ new jobs match your preferences. Apply with resume & profile.',
    list_unsubscribe: true,
  }), 'job_alert');
});

test('leetcode marketing mentioning "coding interview" is a newsletter', () => {
  assert.equal(cat({
    from_domain: 'leetcode.com',
    subject: 'Ace your next coding interview',
    body: 'Prepare for your coding interview with our new study plan. Schedule an interview mock session today!',
    list_unsubscribe: true,
  }), 'newsletter');
});

test('cold recruiter email is recruiter_outreach', () => {
  assert.equal(cat({
    from_domain: 'talentfirm.com',
    subject: 'Software Engineer opportunity',
    body: "Hi Aayush, I came across your profile on LinkedIn and think you'd be a great fit. Are you free to schedule an interview this week?",
  }), 'recruiter_outreach');
});

test('recruiter follow-up about "your application" is an interview', () => {
  assert.equal(cat({
    from_domain: 'stripe.com',
    subject: 'Following up',
    body: "Hi Aayush, I'm a recruiter at Stripe reaching out about your application. Can you share your availability for a phone screen?",
  }), 'interview');
});

test('gmail.com "pleased to offer" via Telegram is a scam', () => {
  assert.equal(cat({
    from_domain: 'gmail.com',
    subject: 'Job offer - Remote Data Entry',
    body: 'We are pleased to offer you the position. Contact our HR manager on Telegram to continue.',
  }), 'scam');
});

test('gmail.com offer letter with no other red flags is still a scam', () => {
  assert.equal(cat({
    from_domain: 'gmail.com',
    subject: 'Your offer letter',
    body: 'Attached is your offer letter for the Analyst role.',
  }), 'scam');
});

test('"no interview required ... send a check" is a scam', () => {
  assert.equal(cat({
    from_domain: 'quickhire-jobs.net',
    subject: 'You are hired!',
    body: 'Congratulations, no interview required. We will send a check to purchase your home office equipment.',
  }), 'scam');
});

test('offer letter', () => {
  assert.equal(cat({
    from_domain: 'stripe.com',
    subject: 'Your Stripe offer letter',
    body: 'We are thrilled to extend you an offer to join Stripe as a Software Engineer. Your offer letter is attached.',
  }), 'offer');
});

test('slugFromUrl', () => {
  assert.equal(slugFromUrl('https://boards.greenhouse.io/stripe/jobs/123456'), 'stripe');
  assert.equal(slugFromUrl('https://job-boards.greenhouse.io/embed/job_app?for=airbnb&token=789'), 'airbnb');
  assert.equal(slugFromUrl('https://jobs.lever.co/netflix/abc-def'), 'netflix');
  assert.equal(slugFromUrl('https://capitalone.wd12.myworkdayjobs.com/Capital_One/job/McLean-VA/Engineer_R1'), 'capitalone');
  assert.equal(slugFromUrl('https://www.amazon.jobs/en/jobs/2712345/sde'), 'amazon');
  assert.equal(slugFromUrl('https://careers.google.com/jobs/results/123'), 'google');
  assert.equal(slugFromUrl('https://www.linkedin.com/jobs/view/4012345678/'), null);
  assert.equal(slugFromUrl('https://jobs.ashbyhq.com/ramp/1234'), 'ramp');
  assert.equal(slugFromUrl('https://careers-acme.icims.com/jobs/1/job'), 'acme');
  assert.equal(slugFromUrl('not a url'), null);
});

test('companyCore drops suffix words', () => {
  assert.equal(companyCore('Amazon.com Services LLC'), 'amazon');
  assert.equal(companyCore('The Goldman Sachs Group, Inc.'), 'goldman sachs');
  assert.equal(companyCore('AT&T'), 'at and t');
});

test('aliasesFor', () => {
  assert.deepEqual(aliasesFor('Amazon.com Services LLC', 'https://www.amazon.jobs/en/jobs/2712345/sde'), ['amazon']);
  assert.deepEqual(
    aliasesFor('Capital One', 'https://capitalone.wd12.myworkdayjobs.com/Capital_One/job/McLean-VA/Engineer_R1'),
    ['capital one', 'capitalone'],
  );
  assert.deepEqual(aliasesFor('Stripe', 'https://www.linkedin.com/jobs/view/1/'), ['stripe']);
});

test('matchJob picks the Stripe role named in the subject', () => {
  const jobs = [
    { id: 1, company: 'Stripe', role: 'Product Designer', url: 'https://stripe.com/jobs/1', status: 'applied', applied_at: '2026-10-20T00:00:00Z' },
    { id: 2, company: 'Stripe', role: 'Backend Software Engineer', url: 'https://stripe.com/jobs/2', status: 'applied', applied_at: '2026-10-01T00:00:00Z' },
    { id: 3, company: 'Figma', role: 'Software Engineer', url: 'https://boards.greenhouse.io/figma/jobs/3', status: 'applied', applied_at: '2026-10-25T00:00:00Z' },
  ];
  const email = { from_name: 'Stripe Recruiting', from_domain: 'stripe.com', subject: 'Backend Software Engineer - next steps', body: 'Hi Aayush' };
  assert.equal(matchJob(jobs, email).id, 2);

  const viaAts = { from_name: 'Figma', from_domain: 'greenhouse-mail.io', subject: 'Thanks for applying', body: '' };
  assert.equal(matchJob(jobs, viaAts).id, 3);
});

test('matchJob returns null for an unknown company', () => {
  const jobs = [{ id: 1, company: 'Stripe', role: 'Engineer', url: null, status: 'applied', applied_at: '2026-10-01' }];
  assert.equal(matchJob(jobs, { from_name: 'Acme HR', from_domain: 'acme.com', subject: 'Interview', body: 'Hello' }), null);
});

test('matchJob prefers stored aliases and breaks ties by newest applied_at', () => {
  const jobs = [
    { id: 1, company: 'Meta Platforms', aliases: 'meta,facebook', role: 'SWE', status: 'applied', applied_at: '2026-09-01' },
    { id: 2, company: 'Meta Platforms', aliases: 'meta,facebook', role: 'SWE', status: 'applied', applied_at: '2026-10-01' },
  ];
  assert.equal(matchJob(jobs, { from_name: 'Facebook Careers', from_domain: 'fb.com', subject: 'Update', body: '' }).id, 2);
});

test('rolesAgree', () => {
  assert.ok(rolesAgree('Software Engineer, New Grad', 'Software Engineer - New Grad 2026'));
  assert.ok(rolesAgree('Software Engineer', 'Senior Software Engineer, Payments'));
  assert.ok(rolesAgree('Software Engineer II', 'Software Engineer'));
  assert.ok(!rolesAgree('Backend Engineer', 'Data Scientist'));
  assert.ok(!rolesAgree('Software Engineer, Payments', 'Software Engineer, Infrastructure'));
});

test('sameCompany', () => {
  assert.ok(sameCompany('Capitalone', 'Capital One'));
  assert.ok(sameCompany('Cerebras', 'Cerebras Systems'));
  assert.ok(sameCompany('Mastercard', 'MasterCard Services'));
  assert.ok(!sameCompany('Meta', 'Metabase'));
  assert.ok(!sameCompany('Square', 'Squarespace'));
  assert.ok(!sameCompany('Intern Co 1', 'Intern Co 10'));
  assert.ok(sameCompany('Questdiagnostics Com', 'Quest Diagnostics'));
  assert.ok(sameCompany('Scale', 'Scale AI'));
  assert.ok(!sameCompany('Stripe', 'Figma'));
});

test('matchJob finds "Cerebras Systems" from an email that says "Cerebras", and F5 by its domain', () => {
  const jobs = [
    { id: 1, company: 'Cerebras Systems', aliases: 'cerebras systems', role: 'Software Engineer', status: 'applied', applied_at: '2026-09-01' },
    { id: 2, company: 'F5', aliases: 'f5', role: null, status: 'applied', applied_at: '2026-09-01' },
  ];
  assert.equal(matchJob(jobs, { from_name: 'Cerebras Recruiting', from_domain: 'greenhouse-mail.io', subject: 'Thank you for applying to Cerebras', body: '' }).id, 1);
  assert.equal(matchJob(jobs, { from_name: 'Talent', from_domain: 'f5.com', subject: 'Update', body: '' }).id, 2);
  assert.equal(matchJob(jobs, { from_name: 'Shopify', from_domain: 'shopify.com', subject: 'Update', body: '' }), null);
});
