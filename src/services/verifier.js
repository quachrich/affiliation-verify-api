const axios = require('axios');
const { parseStringPromise } = require('xml2js');

async function verifyAffiliation(name, institution, department = null, title = null) {
  console.log(`Verifying: ${name} at ${institution}`);

  const [orcid, pubmed, clinicalTrials, nihGrants] = await Promise.all([
    queryOrcid(name, institution).catch(err => ({ error: err.message, found: false })),
    queryPubmed(name, institution).catch(err => ({ error: err.message, found: false })),
    queryClinicalTrials(name, institution).catch(err => ({ error: err.message, found: false })),
    queryNihReporter(name, institution).catch(err => ({ error: err.message, found: false }))
  ]);

  const results = { orcid, pubmed, clinicalTrials, nihGrants };
  return scoreResults(results, name, institution);
}

async function queryOrcid(name, institution) {
  const parts = name.trim().split(' ');
  const lastName = parts.slice(-1)[0];
  const firstName = parts[0];
  const searchUrl = `https://pub.orcid.org/v3.0/search?q=given-names:${encodeURIComponent(firstName)}+AND+family-name:${encodeURIComponent(lastName)}&rows=10`;

  const searchRes = await axios.get(searchUrl, {
    headers: { Accept: 'application/json' },
    timeout: 8000
  });

  const results = searchRes.data.result || [];
  if (results.length === 0) return { found: false };

  // Check each result for institution match
  for (const r of results) {
    const orcidId = r['orcid-identifier'].path;
    const recordUrl = `https://pub.orcid.org/v3.0/${orcidId}/record`;
    const recordRes = await axios.get(recordUrl, {
      headers: { Accept: 'application/json' },
      timeout: 8000
    });

    const record = recordRes.data;
    const affiliationGroups =
      record['activities-summary']?.employments?.['affiliation-group'] || [];

    // Employment is nested under summaries[].employment-summary in the full record
    const summaries = affiliationGroups.flatMap(g =>
      (g.summaries || []).map(s => s['employment-summary']).filter(Boolean)
    );

    const matchingEmployment = summaries.find(s =>
      (s?.organization?.name || '').toLowerCase().includes(institution.toLowerCase())
    );

    if (matchingEmployment) {
      return {
        found: true,
        orcidId,
        displayName: `${record?.person?.name?.['given-names']?.value || ''} ${record?.person?.name?.['family-name']?.value || ''}`.trim(),
        employment: {
          organization: matchingEmployment.organization?.name,
          role: matchingEmployment['role-title'],
          startDate: matchingEmployment['start-date']
        }
      };
    }
  }

  return { found: false };
}

async function queryPubmed(name, institution) {
  const searchTerm = `${name}[Author] AND "${institution}"[Affiliation]`;
  const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(searchTerm)}&retmax=10&retmode=xml`;

  const res = await axios.get(searchUrl, { timeout: 8000 });
  const parsed = await parseStringPromise(res.data);

  const count = parseInt(parsed.eSearchResult.Count?.[0] || '0', 10);
  const pmids = parsed.eSearchResult.IdList?.[0]?.Id || [];

  return {
    found: count > 0,
    publicationCount: count,
    recentPmids: pmids.slice(0, 3)
  };
}

async function queryClinicalTrials(name, institution) {
  const searchUrl = `https://clinicaltrials.gov/api/v2/studies?query.term=${encodeURIComponent(`"${name}"`)}&pageSize=20`;

  const res = await axios.get(searchUrl, { timeout: 8000 });
  const studies = res.data.studies || [];

  const instLower = institution.toLowerCase();
  const nameLower = name.toLowerCase();

  const matchingStudies = studies.filter(study => {
    const proto = study.protocolSection || {};

    // Check sponsor/collaborators for institution
    const sponsor = (proto.sponsorCollaboratorsModule?.leadSponsor?.name || '').toLowerCase();
    const collaborators = (proto.sponsorCollaboratorsModule?.collaborators || [])
      .map(c => (c.name || '').toLowerCase());
    const instMatch = sponsor.includes(instLower) || collaborators.some(c => c.includes(instLower));

    // Check overall contacts for name
    const contacts = proto.contactsLocationsModule?.overallOfficials || [];
    const locationInvs = (proto.contactsLocationsModule?.locations || [])
      .flatMap(loc => loc.investigators || []);
    const nameMatch = [...contacts, ...locationInvs].some(p =>
      (p.name || '').toLowerCase().includes(nameLower)
    );

    return instMatch && nameMatch;
  });

  return {
    found: matchingStudies.length > 0,
    studyCount: matchingStudies.length,
    recentStudies: matchingStudies.slice(0, 2).map(s => ({
      nctId: s.protocolSection?.identificationModule?.nctId,
      title: s.protocolSection?.identificationModule?.officialTitle
    }))
  };
}

async function queryNihReporter(name, institution) {
  const nameParts = name.trim().split(' ');
  const lastName = nameParts.slice(-1)[0];
  const firstName = nameParts[0];

  // Search by PI name only — org filter too strict since grants are filed under specific institutes
  const res = await axios.post(
    'https://api.reporter.nih.gov/v2/projects/search',
    {
      criteria: {
        pi_names: [{ last_name: lastName, first_name: firstName }]
      },
      limit: 25
    },
    { timeout: 8000 }
  );

  const allProjects = res.data.results || [];

  // Filter by institution loosely on org name
  const instLower = institution.toLowerCase();
  const projects = allProjects.filter(p =>
    (p.org_name || '').toLowerCase().includes(instLower) ||
    instLower.includes((p.org_name || '').toLowerCase().split(' ')[0])
  );

  // Fall back to all results if institution is a broad term like "NIH"
  const finalProjects = projects.length > 0 ? projects : allProjects.slice(0, 5);

  return {
    found: finalProjects.length > 0,
    grantCount: finalProjects.length,
    recentGrants: finalProjects.slice(0, 2).map(p => ({
      grantNumber: p.project_num,
      title: p.project_title,
      piName: p.principal_investigators?.[0]?.full_name
    }))
  };
}

function scoreResults(results, name, institution) {
  let score = 0;
  const evidence = [];
  const flags = [];

  const weights = {
    clinicalTrials: 0.30,
    nihGrants: 0.25,
    pubmed: 0.30,
    orcid: 0.15
  };

  if (results.clinicalTrials?.found) {
    score += weights.clinicalTrials;
    evidence.push({
      source: 'ClinicalTrials.gov',
      strength: 'strong',
      detail: `Found as investigator in ${results.clinicalTrials.studyCount} clinical trial(s)`,
      studies: results.clinicalTrials.recentStudies
    });
  }

  if (results.nihGrants?.found) {
    score += weights.nihGrants;
    evidence.push({
      source: 'NIH Reporter',
      strength: 'strong',
      detail: `Found as PI in ${results.nihGrants.grantCount} NIH grant(s)`,
      grants: results.nihGrants.recentGrants
    });
  }

  if (results.pubmed?.found) {
    const pubWeight = weights.pubmed * Math.min(results.pubmed.publicationCount / 3, 1.0);
    score += pubWeight;
    evidence.push({
      source: 'PubMed',
      strength: 'moderate',
      detail: `Found as author in ${results.pubmed.publicationCount} publication(s) affiliated with ${institution}`,
      pmids: results.pubmed.recentPmids
    });
  }

  if (results.orcid?.found) {
    score += weights.orcid;
    evidence.push({
      source: 'ORCID',
      strength: 'moderate',
      detail: `ORCID profile confirms employment at ${institution}`,
      orcidId: results.orcid.orcidId,
      employment: results.orcid.employment
    });
  }

  let status = 'unverified';
  if (score >= 0.8) status = 'verified';
  else if (score >= 0.4) status = 'partial';

  if (score < 0.3) {
    flags.push('No institutional affiliation found in major public databases');
  }

  const sourceErrors = ['clinicalTrials', 'pubmed', 'orcid', 'nihGrants'].filter(
    k => results[k]?.error
  );
  if (sourceErrors.length > 0) {
    flags.push(`Some data sources were unavailable (${sourceErrors.join(', ')}) — confidence may be lower than actual`);
  }

  return {
    confidence: Math.round(score * 100) / 100,
    verified: score >= 0.6,
    status,
    evidence,
    flags,
    sources: results,
    queriedAt: new Date().toISOString()
  };
}

module.exports = { verifyAffiliation };
