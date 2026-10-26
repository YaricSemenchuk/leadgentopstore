import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkedinQueries } from './linkedin.js';
import { findLinkedIn, parseProfileTitle, pickCompany, pickPeople, roleRank, type SearchHit } from './people-search.js';

// Фикстуры — форма реальной выдачи Serper (октябрь 2026); имена людей заменены вымышленными.

const fuse = linkedinQueries('Fuse Entertainment INC', { email: 'support@fusegames.io' });
const zyra = linkedinQueries('MUZA TECHNOLOGIES s.r.o.', { website: 'https://zyra-vpn.com/', email: 'support@muza-technologies.com' });
const lastShelter = linkedinQueries('LAST ORIGIN STUDIO LIMITED', { email: 'service@lastshelter.net' });

test('компания: однофамилец с чужим сайтом и совпадение только по юрлицу отбрасываются', () => {
  const hits: SearchHit[] = [
    { title: 'Fuse Games', link: 'https://uk.linkedin.com/company/fuse-games-uk', snippet: 'www.fusegames.com. External link for Fuse Games. Industry: Computer Games.' },
    { title: 'Fuse Entertainment Group LLP', link: 'https://www.linkedin.com/company/fuse-entertainment-group-llp', snippet: 'This company is no longer active.' },
    { title: 'Empire Interactive', link: 'https://uk.linkedin.com/company/empire-interactive', snippet: 'Website: http://www.fusegames.com.' },
  ];
  assert.equal(pickCompany(hits, fuse), null);
});

test('компания: бренд из домена в названии страницы — подходит, наш домен в карточке — лучше всех', () => {
  const hits: SearchHit[] = [
    { title: 'Fuse Games TR', link: 'https://tr.linkedin.com/company/fusegamestr', snippet: 'Mobile games studio from Ankara' },
    { title: 'Fuse Games', link: 'https://www.linkedin.com/company/fuse-games-official', snippet: 'Website: https://fusegames.io' },
  ];
  assert.equal(pickCompany(hits, fuse), 'https://www.linkedin.com/company/fuse-games-official/');
});

test('компания: страница, где бренд лишь упомянут в тексте, — не та (сеть CPA с офферами Zyra VPN)', () => {
  const hits: SearchHit[] = [
    { title: 'SolCPA Affiliate Network', link: 'https://bg.linkedin.com/company/solcpa', snippet: '... Zyra VPN CPI [WW] IOS SecurityReactor CPT ...' },
  ];
  assert.equal(pickCompany(hits, zyra), null);
});

test('люди: нужен бренд в профиле и роль, решающая о закупке', () => {
  const hits: SearchHit[] = [
    { title: 'Tom Hill - Owner, Fuse Entertainment ltd', link: 'https://uk.linkedin.com/in/tom-hill-1', snippet: 'Owner, Fuse Entertainment ltd · Location: London' },
    { title: 'Jane Roe - Pike x Digital: Strategies for Websites, SEO ...', link: 'https://www.linkedin.com/in/janeroe', snippet: 'FUSE (Entertainment & Media) - Burbank, CA ...' },
    { title: 'Emre Kaya - Co-Founder & Director of Operations at ...', link: 'https://tr.linkedin.com/in/emre-kaya-7', snippet: 'Co-Founder & Director of Operations at Fuse Games · Deneyim: Fuse Games · Konum: Türkiye' },
    { title: 'Alex Moor - Fuse Games', link: 'https://uk.linkedin.com/in/alex-moor-4', snippet: "View Alex's full profile. Alex can introduce you to 10+ people at Fuse Games." },
  ];
  assert.deepEqual(pickPeople(hits, fuse), [
    { name: 'Emre Kaya', title: 'Co-Founder & Director of Operations at ...', url: 'https://www.linkedin.com/in/emre-kaya-7/' },
  ]);
});

test('люди: однофирменник по юрлицу, кадровик и бренд вместо имени отбрасываются', () => {
  const zyraHits: SearchHit[] = [
    { title: 'Peter Banda - Information Technology and Services ...', link: 'https://zm.linkedin.com/in/peter-banda', snippet: 'Experience: Muza Technologies Limited Company · Lusaka' },
    { title: 'Mary Phiri - Human Resource Partner', link: 'https://zm.linkedin.com/in/mary-phiri', snippet: 'Managing Director. Muza-Technologies ...' },
  ];
  assert.deepEqual(pickPeople(zyraHits, zyra), []);
  const lsHits: SearchHit[] = [
    { title: 'LastShelter Base - Manager at Cisco', link: 'https://in.linkedin.com/in/lastshelter-base-a1', snippet: 'Manager at Cisco · Experience: Cisco' },
  ];
  assert.deepEqual(pickPeople(lsHits, lastShelter), []);
});

test('роли: владельцы и маркетинг выше прочих, HR и студенты — мимо', () => {
  assert.equal(roleRank('CEO & Founder', ''), 0);
  assert.equal(roleRank('Head of User Acquisition', ''), 1);
  assert.equal(roleRank('Product Manager', ''), 2);
  assert.equal(roleRank('Talent Acquisition Partner', ''), null);
  assert.equal(roleRank(null, 'Co-Founder at Fuse Games'), 0);
});

test('заголовок профиля: имя и должность', () => {
  assert.deepEqual(parseProfileTitle('Luong Vuong | LinkedIn'), { name: 'Luong Vuong', title: null });
  assert.deepEqual(parseProfileTitle('Ann Lee - Head of Marketing - Studio X'), { name: 'Ann Lee', title: 'Head of Marketing · Studio X' });
});

test('findLinkedIn: два запроса; частное лицо — один, его профиль', async () => {
  const queries: string[] = [];
  await findLinkedIn('LAST ORIGIN STUDIO LIMITED', { email: 'service@lastshelter.net' }, async (q) => {
    queries.push(q);
    return [];
  });
  assert.equal(queries.length, 2);
  assert.match(queries[0], /^site:linkedin\.com\/company \("lastshelter" OR "LAST ORIGIN STUDIO"\)$/);

  const person = await findLinkedIn('Luong Vuong', {}, async () => [
    { title: 'Luong Vuong - Indie Game Developer', link: 'https://vn.linkedin.com/in/luongvuong', snippet: '' },
  ]);
  assert.equal(person.companyUrl, null);
  assert.deepEqual(person.people, [{ name: 'Luong Vuong', title: 'Indie Game Developer', url: 'https://www.linkedin.com/in/luongvuong/' }]);
});

test('короткий бренд: чужая «Berk Enterprises» — мимо; длинное юрлицо или наш домен — да', () => {
  const berk = linkedinQueries('PT SANDI DAYA GUNA', { email: 'service@berk.love' });
  assert.equal(pickCompany([{ title: 'Berk Enterprises', link: 'https://www.linkedin.com/company/berk-enterprises', snippet: '' }], berk), null);
  // короткое название без домена — не доказательство, даже при точном совпадении
  assert.equal(pickCompany([{ title: 'Berk', link: 'https://id.linkedin.com/company/berk-app', snippet: '' }], berk), null);
  assert.equal(pickCompany([{ title: 'Berk', link: 'https://id.linkedin.com/company/berk-app', snippet: 'Website: https://berk.love' }], berk), 'https://www.linkedin.com/company/berk-app/');
  const lava = linkedinQueries('LAVA LABS OYUN YAZILIM VE PAZARLAMA ANONIM SIRKETI', { email: 'info@lava.gs' });
  assert.equal(pickCompany([{ title: 'Lava Labs', link: 'https://tr.linkedin.com/company/lava-labs', snippet: '' }], lava), 'https://www.linkedin.com/company/lava-labs/');
});

test('люди: бренд должен быть текущим местом работы, а не упоминанием в тексте', () => {
  const hits: SearchHit[] = [
    { title: 'Sam Doe - Enterprise Transformation', link: 'https://www.linkedin.com/in/sam-doe', snippet: 'Enterprise Transformation · Experience: Big Bank · Previously advised GameSpark on L&D' },
    { title: 'Li Wei - Head of Marketing', link: 'https://sg.linkedin.com/in/li-wei', snippet: 'Head of Marketing · Experience: Game Spark Pte. Ltd. · Location: Singapore' },
  ];
  const q = linkedinQueries('GAME SPARK PTE. LTD.', { email: 'toplords-support@gamespark.net' });
  assert.deepEqual(pickPeople(hits, q).map((p) => p.name), ['Li Wei']);
});

test('бренд должен стоять на месте работодателя, а не внутри чужого названия', () => {
  const combo = linkedinQueries('Combo Yazilim Anonim Sirketi', { website: 'https://combo-games.net/', email: 'info@khronikgames.com' });
  assert.equal(pickCompany([{ title: 'Double Combo Games', link: 'https://www.linkedin.com/company/double-combo', snippet: '' }], combo), null);
  assert.deepEqual(
    pickPeople([{ title: 'Ivo Marin - CEO Double Combo Games', link: 'https://fr.linkedin.com/in/ivo', snippet: 'CEO Double Combo Games · Experience: Double Combo Games' }], combo),
    [],
  );
  assert.deepEqual(
    pickPeople([{ title: 'Ece Yildiz - Founder at Combo Games', link: 'https://tr.linkedin.com/in/ece', snippet: '' }], combo).map((p) => p.name),
    ['Ece Yildiz'],
  );
});

test('однословный бренд не цепляет чужие фирмы: Gryphon Strategies, SunQuest Solar', () => {
  const gryphon = linkedinQueries('Gryphon Games UG (haftungsbeschrankt)', { website: 'https://www.gryphon.games/' });
  const hits: SearchHit[] = [
    { title: 'Jo Day - President & CEO, Gryphon Strategies', link: 'https://www.linkedin.com/in/jo-day', snippet: '' },
    { title: 'Dan Ruiz - Co-Founder @ Gryphon Games', link: 'https://www.linkedin.com/in/dan-ruiz', snippet: '' },
  ];
  assert.deepEqual(pickPeople(hits, gryphon).map((p) => p.name), ['Dan Ruiz']);
  const sun = linkedinQueries('Apextens', { website: 'https://sunquest.app', email: 'contact@apextens.io' });
  const sunHits: SearchHit[] = [
    { title: 'Ty Barg - Founder at SunQuest Marketing, LLC.', link: 'https://www.linkedin.com/in/ty', snippet: '' },
    { title: 'Mia Chen - CEO at Apextens', link: 'https://www.linkedin.com/in/mia', snippet: '' },
  ];
  assert.deepEqual(pickPeople(sunHits, sun).map((p) => p.name), ['Mia Chen']);
});

test('бывшая работа в заголовке не считается, если «Опыт» — другая компания', () => {
  const mullvad = linkedinQueries('Mullvad VPN AB', { website: 'https://mullvad.net/' });
  const hits: SearchHit[] = [
    { title: 'Jon J. - Founder, Encuro AB · Former CEO, Mullvad VPN', link: 'https://se.linkedin.com/in/jon', snippet: 'Experience: Encuro AB' },
    { title: 'Ida N. - Head of Marketing', link: 'https://se.linkedin.com/in/ida', snippet: 'Head of Marketing · Experience: Mullvad VPN' },
  ];
  assert.deepEqual(pickPeople(hits, mullvad).map((p) => p.name), ['Ida N.']);
});

test('частный разработчик: однофамильцы не из разработки отбрасываются', () => {
  const q = linkedinQueries('Thu Nguyen', {});
  const hits: SearchHit[] = [
    { title: 'Thu Nguyen - Non-profit executive leading through culture', link: 'https://www.linkedin.com/in/thu-1', snippet: '' },
    { title: 'Thu Nguyen - Senior Research Associate at Duke', link: 'https://www.linkedin.com/in/thu-2', snippet: '' },
    { title: 'Thu Nguyen - Indie iOS Developer', link: 'https://vn.linkedin.com/in/thu-3', snippet: '' },
    { title: 'Thu Nguyen - Systems Engineer at Marvel Studios', link: 'https://www.linkedin.com/in/thu-4', snippet: '' },
  ];
  assert.deepEqual(pickPeople(hits, q).map((p) => p.url), ['https://www.linkedin.com/in/thu-3/']);
});
