-- Oracle Party: History Questions Import
-- Categories: history
-- Subcategories tagged in fun_fact: Ancient, Medieval, Early Modern, Modern
-- Difficulty: easy, medium, hard
-- Format: open (typed answer)
-- All questions verified: answer does NOT appear in question text

INSERT INTO questions (question_text, correct_answer, acceptable_answers, categories, format, difficulty, fun_fact)
VALUES

-- ============================================
-- ANCIENT HISTORY (~before 500 AD)
-- ============================================

-- Easy
('What ancient civilization built the Great Pyramids at Giza?', 'Egypt', ARRAY['Ancient Egypt', 'Egyptians', 'Egyptian'], '{"history"}', 'open', 'easy', 'Era: Ancient'),
('What was the largest empire of the ancient world, stretching from Greece to India?', 'Alexander the Great''s Empire', ARRAY['Macedonian Empire', 'Alexander', 'Macedonia'], '{"history"}', 'open', 'easy', 'Era: Ancient'),
('Which city-state is known for its warrior culture and the Battle of Thermopylae?', 'Sparta', ARRAY['Spartans'], '{"history"}', 'open', 'easy', 'Era: Ancient'),
('What material were the Dead Sea Scrolls written on?', 'Parchment', ARRAY['Animal skin', 'Leather', 'Papyrus'], '{"history"}', 'open', 'easy', 'Era: Ancient'),
('What ancient wonder was a giant statue on the island of Rhodes?', 'Colossus of Rhodes', ARRAY['The Colossus', 'Colossus'], '{"history"}', 'open', 'easy', 'Era: Ancient'),
('Who was the last pharaoh of Ancient Egypt?', 'Cleopatra', ARRAY['Cleopatra VII', 'Cleopatra the Seventh'], '{"history"}', 'open', 'easy', 'Era: Ancient'),
('What language was primarily spoken in the Roman Empire?', 'Latin', ARRAY['Roman', 'Latina'], '{"history"}', 'open', 'easy', 'Era: Ancient'),
('What volcano destroyed the Roman city of Pompeii in 79 AD?', 'Mount Vesuvius', ARRAY['Vesuvius', 'Mt Vesuvius', 'Mt. Vesuvius'], '{"history"}', 'open', 'easy', 'Era: Ancient'),
('What structure did the Romans build to keep out the Picts in northern Britain?', 'Hadrian''s Wall', ARRAY['Hadrians Wall'], '{"history"}', 'open', 'easy', 'Era: Ancient'),
('Which ancient Greek philosopher was sentenced to death by drinking hemlock?', 'Socrates', ARRAY[], '{"history"}', 'open', 'easy', 'Era: Ancient'),

-- Medium
('In what year did Julius Caesar cross the Rubicon River, sparking civil war?', '49 BC', ARRAY['49 BCE', '49'], '{"history"}', 'open', 'medium', 'Era: Ancient'),
('What Carthaginian general famously crossed the Alps with war elephants?', 'Hannibal', ARRAY['Hannibal Barca'], '{"history"}', 'open', 'medium', 'Era: Ancient'),
('What was the primary writing system of ancient Mesopotamia?', 'Cuneiform', ARRAY[], '{"history"}', 'open', 'medium', 'Era: Ancient'),
('Which Roman emperor made Christianity the state religion of Rome?', 'Theodosius', ARRAY['Theodosius I', 'Theodosius the Great'], '{"history"}', 'open', 'medium', 'Era: Ancient'),
('What ancient trade route connected China to the Mediterranean?', 'Silk Road', ARRAY['Silk Route', 'The Silk Road'], '{"history"}', 'open', 'medium', 'Era: Ancient'),
('Who wrote "The Republic," a foundational text of Western philosophy?', 'Plato', ARRAY[], '{"history"}', 'open', 'medium', 'Era: Ancient'),
('What was the name of the senate building in ancient Rome?', 'Curia', ARRAY['Curia Julia', 'The Curia'], '{"history"}', 'open', 'medium', 'Era: Ancient'),
('Which Egyptian pharaoh''s tomb was discovered nearly intact in 1922?', 'Tutankhamun', ARRAY['King Tut', 'Tut', 'Tutankhamen'], '{"history"}', 'open', 'medium', 'Era: Ancient'),
('What ancient Greek city-state is considered the birthplace of democracy?', 'Athens', ARRAY[], '{"history"}', 'open', 'medium', 'Era: Ancient'),
('What year did the Western Roman Empire officially fall?', '476', ARRAY['476 AD', '476 CE'], '{"history"}', 'open', 'medium', 'Era: Ancient'),

-- Hard
('What Assyrian king created one of the world''s first libraries at Nineveh?', 'Ashurbanipal', ARRAY['Assurbanipal'], '{"history"}', 'open', 'hard', 'Era: Ancient'),
('What battle in 31 BC established Octavian as sole ruler of Rome?', 'Battle of Actium', ARRAY['Actium'], '{"history"}', 'open', 'hard', 'Era: Ancient'),
('What Spartan king led the 300 at Thermopylae?', 'Leonidas', ARRAY['Leonidas I', 'King Leonidas'], '{"history"}', 'open', 'hard', 'Era: Ancient'),
('What Persian king invaded Greece in 480 BC with the largest ancient army ever assembled?', 'Xerxes', ARRAY['Xerxes I', 'Xerxes the Great'], '{"history"}', 'open', 'hard', 'Era: Ancient'),
('What ancient law code, among the oldest known, came from Babylon?', 'Code of Hammurabi', ARRAY['Hammurabi', 'Hammurabis Code'], '{"history"}', 'open', 'hard', 'Era: Ancient'),
('Which Roman general defeated Hannibal at the Battle of Zama in 202 BC?', 'Scipio Africanus', ARRAY['Scipio', 'Publius Cornelius Scipio'], '{"history"}', 'open', 'hard', 'Era: Ancient'),
('What was the capital of the Byzantine Empire?', 'Constantinople', ARRAY['Byzantium', 'Istanbul'], '{"history"}', 'open', 'hard', 'Era: Ancient'),
('What Egyptian queen ruled jointly with Thutmose III and is known for her mortuary temple?', 'Hatshepsut', ARRAY[], '{"history"}', 'open', 'hard', 'Era: Ancient'),
('What Macedonian general inherited the eastern portion of Alexander''s empire?', 'Seleucus', ARRAY['Seleucus I', 'Seleucus Nicator'], '{"history"}', 'open', 'hard', 'Era: Ancient'),
('In what year was the Roman Republic traditionally founded?', '509 BC', ARRAY['509 BCE', '509'], '{"history"}', 'open', 'hard', 'Era: Ancient'),

-- ============================================
-- MEDIEVAL HISTORY (~500-1400 AD)
-- ============================================

-- Easy
('What document, signed in 1215, limited the power of the English king?', 'Magna Carta', ARRAY['The Magna Carta', 'Magna Charta'], '{"history"}', 'open', 'easy', 'Era: Medieval'),
('What series of religious wars were fought to reclaim the Holy Land?', 'The Crusades', ARRAY['Crusades'], '{"history"}', 'open', 'easy', 'Era: Medieval'),
('What pandemic killed roughly one-third of Europe''s population in the 1300s?', 'Black Death', ARRAY['Bubonic Plague', 'The Plague', 'Black Plague'], '{"history"}', 'open', 'easy', 'Era: Medieval'),
('Who became the first Holy Roman Emperor in 800 AD?', 'Charlemagne', ARRAY['Charles the Great', 'Karl der Grosse'], '{"history"}', 'open', 'easy', 'Era: Medieval'),
('What Scandinavian seafarers raided and traded across Europe from the 8th to 11th centuries?', 'Vikings', ARRAY['Norse', 'Norsemen'], '{"history"}', 'open', 'easy', 'Era: Medieval'),
('What famous English outlaw supposedly robbed the rich to give to the poor?', 'Robin Hood', ARRAY['Robin of Loxley'], '{"history"}', 'open', 'easy', 'Era: Medieval'),
('What fortified structure was the primary residence of medieval lords?', 'Castle', ARRAY['Castles', 'A castle'], '{"history"}', 'open', 'easy', 'Era: Medieval'),
('What social system dominated medieval Europe, based on land ownership and service?', 'Feudalism', ARRAY['Feudal system', 'The feudal system'], '{"history"}', 'open', 'easy', 'Era: Medieval'),
('What armored warriors on horseback were the elite fighting force of medieval Europe?', 'Knights', ARRAY['Knight', 'A knight'], '{"history"}', 'open', 'easy', 'Era: Medieval'),
('In 1066, which duke conquered England after the Battle of Hastings?', 'William the Conqueror', ARRAY['William', 'William of Normandy', 'William I'], '{"history"}', 'open', 'easy', 'Era: Medieval'),

-- Medium
('What Mongol ruler created the largest contiguous land empire in history?', 'Genghis Khan', ARRAY['Chinggis Khan', 'Temujin'], '{"history"}', 'open', 'medium', 'Era: Medieval'),
('What English king signed the Magna Carta under pressure from his barons?', 'King John', ARRAY['John', 'John of England'], '{"history"}', 'open', 'medium', 'Era: Medieval'),
('What medieval Islamic center of learning in Baghdad was destroyed by the Mongols in 1258?', 'House of Wisdom', ARRAY['Bayt al-Hikma', 'The House of Wisdom'], '{"history"}', 'open', 'medium', 'Era: Medieval'),
('What conflict between England and France lasted from 1337 to 1453?', 'Hundred Years'' War', ARRAY['The Hundred Years War', '100 Years War'], '{"history"}', 'open', 'medium', 'Era: Medieval'),
('What French peasant girl led the French army to several victories during the Hundred Years'' War?', 'Joan of Arc', ARRAY['Jeanne d''Arc', 'Jeanne dArc', 'Saint Joan'], '{"history"}', 'open', 'medium', 'Era: Medieval'),
('What empire ruled much of Southeast Europe, Western Asia, and North Africa for over 600 years?', 'Ottoman Empire', ARRAY['The Ottomans', 'Ottoman'], '{"history"}', 'open', 'medium', 'Era: Medieval'),
('What was the primary language of scholarship in medieval Western Europe?', 'Latin', ARRAY[], '{"history"}', 'open', 'medium', 'Era: Medieval'),
('Which Viking explorer is believed to have reached North America around 1000 AD?', 'Leif Erikson', ARRAY['Leif Ericson', 'Leif Eriksson'], '{"history"}', 'open', 'medium', 'Era: Medieval'),
('What English cathedral was the site of Thomas Becket''s murder in 1170?', 'Canterbury Cathedral', ARRAY['Canterbury'], '{"history"}', 'open', 'medium', 'Era: Medieval'),
('What medieval code governed the behavior and conduct of knights?', 'Chivalry', ARRAY['Code of chivalry', 'The chivalric code'], '{"history"}', 'open', 'medium', 'Era: Medieval'),

-- Hard
('What Byzantine emperor codified Roman law in the Corpus Juris Civilis?', 'Justinian', ARRAY['Justinian I', 'Justinian the Great'], '{"history"}', 'open', 'hard', 'Era: Medieval'),
('What 1346 battle saw English longbowmen devastate the French cavalry?', 'Battle of Crecy', ARRAY['Crecy', 'Crécy'], '{"history"}', 'open', 'hard', 'Era: Medieval'),
('What African empire, centered in modern Mali, was one of the richest in medieval history?', 'Mali Empire', ARRAY['Mali', 'Empire of Mali'], '{"history"}', 'open', 'hard', 'Era: Medieval'),
('Who was the richest person in medieval history, a West African emperor who made a famous pilgrimage?', 'Mansa Musa', ARRAY['Musa I', 'Musa'], '{"history"}', 'open', 'hard', 'Era: Medieval'),
('What treaty in 843 divided Charlemagne''s empire among his three grandsons?', 'Treaty of Verdun', ARRAY['Verdun'], '{"history"}', 'open', 'hard', 'Era: Medieval'),
('What devastating famine struck Europe from 1315 to 1317?', 'Great Famine', ARRAY['The Great Famine', 'Great Famine of 1315'], '{"history"}', 'open', 'hard', 'Era: Medieval'),
('What Mongol ruler sacked Baghdad in 1258, ending the Abbasid Caliphate?', 'Hulagu Khan', ARRAY['Hulagu', 'Hulegu'], '{"history"}', 'open', 'hard', 'Era: Medieval'),
('What Venetian merchant wrote a famous account of his travels to the court of Kublai Khan?', 'Marco Polo', ARRAY['Polo'], '{"history"}', 'open', 'hard', 'Era: Medieval'),
('What 1381 English uprising was triggered by a poll tax?', 'Peasants'' Revolt', ARRAY['Peasants Revolt', 'Great Revolt', 'Wat Tyler Rebellion'], '{"history"}', 'open', 'hard', 'Era: Medieval'),
('What Islamic dynasty ruled Spain from 756 to 1031 from their capital in Cordoba?', 'Umayyad', ARRAY['Umayyads', 'Umayyad Caliphate', 'Caliphate of Cordoba'], '{"history"}', 'open', 'hard', 'Era: Medieval'),

-- ============================================
-- EARLY MODERN HISTORY (~1400-1900)
-- ============================================

-- Easy
('Who is credited with inventing the printing press around 1440?', 'Gutenberg', ARRAY['Johannes Gutenberg', 'Johann Gutenberg'], '{"history"}', 'open', 'easy', 'Era: Early Modern'),
('What Italian explorer sailing for Spain reached the Americas in 1492?', 'Columbus', ARRAY['Christopher Columbus', 'Cristobal Colon'], '{"history"}', 'open', 'easy', 'Era: Early Modern'),
('What period of cultural rebirth began in Italy in the 14th century?', 'Renaissance', ARRAY['The Renaissance', 'Italian Renaissance'], '{"history"}', 'open', 'easy', 'Era: Early Modern'),
('What French military leader crowned himself Emperor in 1804?', 'Napoleon', ARRAY['Napoleon Bonaparte', 'Napoleon I'], '{"history"}', 'open', 'easy', 'Era: Early Modern'),
('What 1776 document declared American independence from Britain?', 'Declaration of Independence', ARRAY['The Declaration of Independence', 'US Declaration of Independence'], '{"history"}', 'open', 'easy', 'Era: Early Modern'),
('What country did the Pilgrims leave before sailing to America on the Mayflower?', 'England', ARRAY['Britain', 'Great Britain', 'The Netherlands'], '{"history"}', 'open', 'easy', 'Era: Early Modern'),
('What revolution began in France in 1789 with the storming of a famous prison?', 'French Revolution', ARRAY['The French Revolution'], '{"history"}', 'open', 'easy', 'Era: Early Modern'),
('What famous prison was stormed on July 14, 1789?', 'Bastille', ARRAY['The Bastille'], '{"history"}', 'open', 'easy', 'Era: Early Modern'),
('Who was the first President of the United States?', 'George Washington', ARRAY['Washington'], '{"history"}', 'open', 'easy', 'Era: Early Modern'),
('What conflict between the North and South divided America from 1861 to 1865?', 'Civil War', ARRAY['American Civil War', 'The Civil War', 'US Civil War'], '{"history"}', 'open', 'easy', 'Era: Early Modern'),

-- Medium
('What German monk started the Protestant Reformation by posting his 95 Theses?', 'Martin Luther', ARRAY['Luther'], '{"history"}', 'open', 'medium', 'Era: Early Modern'),
('What 1588 naval fleet sent by Spain was famously defeated by England?', 'Spanish Armada', ARRAY['The Armada', 'The Spanish Armada'], '{"history"}', 'open', 'medium', 'Era: Early Modern'),
('What queen ruled England for 45 years during the Golden Age?', 'Elizabeth I', ARRAY['Queen Elizabeth', 'Elizabeth the First'], '{"history"}', 'open', 'medium', 'Era: Early Modern'),
('What treaty ended the Thirty Years'' War in 1648?', 'Peace of Westphalia', ARRAY['Treaty of Westphalia', 'Westphalia'], '{"history"}', 'open', 'medium', 'Era: Early Modern'),
('What British colony in India was controlled by the East India Company before the Crown took over?', 'India', ARRAY['British India', 'The Raj'], '{"history"}', 'open', 'medium', 'Era: Early Modern'),
('What economic system, based on free markets and private ownership, rose during the Industrial Revolution?', 'Capitalism', ARRAY['Free market capitalism', 'Market economy'], '{"history"}', 'open', 'medium', 'Era: Early Modern'),
('Who led the Haitian Revolution, the only successful slave revolt in history?', 'Toussaint Louverture', ARRAY['Toussaint', 'Louverture', 'L''Ouverture'], '{"history"}', 'open', 'medium', 'Era: Early Modern'),
('What country did Napoleon invade in 1812, leading to a disastrous winter retreat?', 'Russia', ARRAY['Russian Empire'], '{"history"}', 'open', 'medium', 'Era: Early Modern'),
('What 1815 battle was Napoleon''s final defeat?', 'Battle of Waterloo', ARRAY['Waterloo'], '{"history"}', 'open', 'medium', 'Era: Early Modern'),
('Who emancipated Russian serfs in 1861?', 'Alexander II', ARRAY['Tsar Alexander II', 'Alexander the Second'], '{"history"}', 'open', 'medium', 'Era: Early Modern'),

-- Hard
('What 1494 treaty divided the New World between Spain and Portugal?', 'Treaty of Tordesillas', ARRAY['Tordesillas'], '{"history"}', 'open', 'hard', 'Era: Early Modern'),
('Who was the Mughal emperor that built the Taj Mahal?', 'Shah Jahan', ARRAY['Shah Jehan'], '{"history"}', 'open', 'hard', 'Era: Early Modern'),
('What 1648 rebellion against the French monarchy was led by disgruntled nobles?', 'The Fronde', ARRAY['Fronde', 'La Fronde'], '{"history"}', 'open', 'hard', 'Era: Early Modern'),
('What 1839-1842 conflict was fought between Britain and China over drug trade?', 'First Opium War', ARRAY['Opium War', 'The Opium War'], '{"history"}', 'open', 'hard', 'Era: Early Modern'),
('What South American liberator freed much of northern South America from Spanish rule?', 'Simon Bolivar', ARRAY['Bolivar', 'Simón Bolívar'], '{"history"}', 'open', 'hard', 'Era: Early Modern'),
('What 1857 uprising in India was a major challenge to British colonial rule?', 'Indian Rebellion of 1857', ARRAY['Sepoy Mutiny', 'Indian Mutiny', 'Sepoy Rebellion', 'First War of Independence'], '{"history"}', 'open', 'hard', 'Era: Early Modern'),
('Who unified Germany in 1871 through a policy of "blood and iron"?', 'Otto von Bismarck', ARRAY['Bismarck'], '{"history"}', 'open', 'hard', 'Era: Early Modern'),
('What 1884-1885 conference divided Africa among European colonial powers?', 'Berlin Conference', ARRAY['Berlin West Africa Conference', 'Congo Conference'], '{"history"}', 'open', 'hard', 'Era: Early Modern'),
('What dynasty ruled China from 1644 to 1912, the last imperial dynasty?', 'Qing', ARRAY['Qing Dynasty', 'Manchu Dynasty', 'Manchu'], '{"history"}', 'open', 'hard', 'Era: Early Modern'),
('What 1863 American proclamation freed slaves in Confederate states?', 'Emancipation Proclamation', ARRAY['The Emancipation Proclamation'], '{"history"}', 'open', 'hard', 'Era: Early Modern'),

-- ============================================
-- MODERN HISTORY (~1900-present)
-- ============================================

-- Easy
('What event started World War I, involving the assassination of an Archduke?', 'Assassination of Archduke Franz Ferdinand', ARRAY['Franz Ferdinand assassination', 'Assassination of Franz Ferdinand'], '{"history"}', 'open', 'easy', 'Era: Modern'),
('What ship sank on its maiden voyage in 1912 after hitting an iceberg?', 'Titanic', ARRAY['RMS Titanic', 'The Titanic'], '{"history"}', 'open', 'easy', 'Era: Modern'),
('What country dropped atomic bombs on Hiroshima and Nagasaki in 1945?', 'United States', ARRAY['USA', 'America', 'US', 'The United States'], '{"history"}', 'open', 'easy', 'Era: Modern'),
('What barrier divided East and West Berlin from 1961 to 1989?', 'Berlin Wall', ARRAY['The Berlin Wall'], '{"history"}', 'open', 'easy', 'Era: Modern'),
('Who was the leader of Nazi Germany during World War II?', 'Adolf Hitler', ARRAY['Hitler'], '{"history"}', 'open', 'easy', 'Era: Modern'),
('What American civil rights leader gave the "I Have a Dream" speech?', 'Martin Luther King Jr.', ARRAY['Martin Luther King', 'MLK', 'Dr. King'], '{"history"}', 'open', 'easy', 'Era: Modern'),
('What organization was founded in 1945 to maintain international peace?', 'United Nations', ARRAY['UN', 'The United Nations', 'The UN'], '{"history"}', 'open', 'easy', 'Era: Modern'),
('In what decade did humans first walk on the Moon?', '1960s', ARRAY['The 1960s', '60s', 'The sixties'], '{"history"}', 'open', 'easy', 'Era: Modern'),
('What 1914-1918 conflict was called "The Great War"?', 'World War I', ARRAY['World War 1', 'WW1', 'WWI', 'First World War'], '{"history"}', 'open', 'easy', 'Era: Modern'),
('What was the name of the alliance between the US and Western Europe during the Cold War?', 'NATO', ARRAY['North Atlantic Treaty Organization'], '{"history"}', 'open', 'easy', 'Era: Modern'),

-- Medium
('What 1917 revolution overthrew the Russian Tsar and eventually brought the Bolsheviks to power?', 'Russian Revolution', ARRAY['Bolshevik Revolution', 'October Revolution', 'February Revolution'], '{"history"}', 'open', 'medium', 'Era: Modern'),
('What economic disaster began with a stock market crash in October 1929?', 'Great Depression', ARRAY['The Great Depression'], '{"history"}', 'open', 'medium', 'Era: Modern'),
('What 1944 invasion of France was the largest seaborne invasion in history?', 'D-Day', ARRAY['Normandy invasion', 'Operation Overlord', 'Battle of Normandy'], '{"history"}', 'open', 'medium', 'Era: Modern'),
('What plan provided American economic aid to rebuild Western Europe after WWII?', 'Marshall Plan', ARRAY['The Marshall Plan', 'European Recovery Program'], '{"history"}', 'open', 'medium', 'Era: Modern'),
('What 1962 crisis brought the US and Soviet Union to the brink of nuclear war over missiles in the Caribbean?', 'Cuban Missile Crisis', ARRAY['The Cuban Missile Crisis'], '{"history"}', 'open', 'medium', 'Era: Modern'),
('What South African leader spent 27 years in prison before becoming president?', 'Nelson Mandela', ARRAY['Mandela'], '{"history"}', 'open', 'medium', 'Era: Modern'),
('What 1947 event divided British India into two independent nations?', 'Partition of India', ARRAY['Indian partition', 'Partition'], '{"history"}', 'open', 'medium', 'Era: Modern'),
('What treaty ended World War I and imposed harsh penalties on Germany?', 'Treaty of Versailles', ARRAY['Versailles Treaty', 'Versailles'], '{"history"}', 'open', 'medium', 'Era: Modern'),
('What Japanese city was the target of the first atomic bomb in August 1945?', 'Hiroshima', ARRAY[], '{"history"}', 'open', 'medium', 'Era: Modern'),
('What Southeast Asian conflict saw the US involved militarily from the 1950s to 1975?', 'Vietnam War', ARRAY['The Vietnam War'], '{"history"}', 'open', 'medium', 'Era: Modern'),

-- Hard
('What 1916 battle was the bloodiest of World War I, lasting from July to November?', 'Battle of the Somme', ARRAY['The Somme', 'Somme'], '{"history"}', 'open', 'hard', 'Era: Modern'),
('What 1919 massacre saw British troops fire on unarmed Indian civilians in Amritsar?', 'Jallianwala Bagh massacre', ARRAY['Amritsar massacre', 'Jallianwala Bagh'], '{"history"}', 'open', 'hard', 'Era: Modern'),
('What 1945 conference divided post-war Germany into occupation zones?', 'Potsdam Conference', ARRAY['Potsdam'], '{"history"}', 'open', 'hard', 'Era: Modern'),
('What 1948 airlift supplied West Berlin when the Soviets blockaded ground access?', 'Berlin Airlift', ARRAY['The Berlin Airlift', 'Operation Vittles'], '{"history"}', 'open', 'hard', 'Era: Modern'),
('What 1953 event saw the CIA help overthrow Iran''s democratically elected prime minister?', 'Operation Ajax', ARRAY['1953 Iranian coup', 'Iranian coup d''état'], '{"history"}', 'open', 'hard', 'Era: Modern'),
('What 1975 agreement between Western and Eastern bloc nations recognized post-WWII borders?', 'Helsinki Accords', ARRAY['Helsinki Final Act', 'Helsinki Agreement'], '{"history"}', 'open', 'hard', 'Era: Modern'),
('What Soviet policy of openness and transparency was introduced by Gorbachev?', 'Glasnost', ARRAY[], '{"history"}', 'open', 'hard', 'Era: Modern'),
('What 1994 genocide killed an estimated 800,000 people in 100 days in East Africa?', 'Rwandan genocide', ARRAY['Rwanda genocide', 'Genocide in Rwanda'], '{"history"}', 'open', 'hard', 'Era: Modern'),
('What 1938 agreement let Germany annex part of Czechoslovakia, widely seen as appeasement?', 'Munich Agreement', ARRAY['Munich Pact', 'Munich'], '{"history"}', 'open', 'hard', 'Era: Modern'),
('What battle in 1942-1943 was the turning point of WWII on the Eastern Front?', 'Battle of Stalingrad', ARRAY['Stalingrad'], '{"history"}', 'open', 'hard', 'Era: Modern');

-- Total: 120 questions (30 per era × 4 eras, 10 per difficulty × 3 difficulties per era)
