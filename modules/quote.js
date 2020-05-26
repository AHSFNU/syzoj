
const fs = require('fs-extra');
const pathlib = require('path');
const randomstring = require('randomstring');

const User = syzoj.model('user');
const Quote = syzoj.model('quote');
const QuoteFrom = syzoj.model('quote-from');
const QuoteUserVote = syzoj.model('quote-user-vote');

const { baseDir, isValidImageExt } = Quote;
const { assert } = syzoj.utils;

const config = syzoj.config.custom_hitokoto;

syzoj.utils.lock(['Quote::Image'], () => fs.ensureDir(baseDir));

function checkHandler(req, res, next) {
  assert(config && config.enabled, "这里什么也没有……");
  assert(res.locals.user, "请先登录");
  next();
}

app.use(['/quote', '/quotes', '/quote-image'], (req, res, next) => {
  try {
    checkHandler(req, res, next);
  } catch (e) {
    res.render('error', {
      err: e
    })
  }
});
app.use('/api/quote', (req, res, next) => {
  try {
    checkHandler(req, res, next);
  } catch (e) {
    res.send({
      error: e.message
    });
  }
});

async function processQuote(quote, user, privileged) {
  await quote.loadRelationships();
  await quote.render();

  return {
    ...quote.toJSON(privileged),
    vote: await quote.getVoteSummary(user)
  };
}

app.get('/api/quote', async (req, res) => {
  try {
    const where = {};
    if (req.query.from) {
      const { from } = req.query;
      assert(typeof from === 'string' && syzoj.utils.isValidUsername(from));
      where.from = from;
    }
    if (req.query.type) {
      const { type } = req.query;
      assert(['hitokoto', 'quote'].includes(type));
      where.type = type;
    }

    const quote = await Quote.pickOne(where);
    assert(quote, "这里什么也没有……");

    res.send({
      error: null,
      result: await processQuote(quote, res.locals.user)
    });
  } catch (e) {
    syzoj.log(e);
    res.send({
      error: e.message
    });
  }
});

function sendQuoteImage(res, filename) {
  const path = pathlib.join(baseDir, filename);
  res.sendFile(path, err => {
    if (err) {
      res.status(404).render('error', {
        err: new ErrorMessage("这条语录似乎走丢了……？")
      });
    }
  });
}

app.get('/quote-image', async (req, res) => {
  try {
    const quote = await Quote.pickOne({
      type: 'image',
      from: req.query.from || null
    });
    assert(quote, "这里什么也没有……");

    sendQuoteImage(res, quote.content.filename);
  } catch (e) {
    syzoj.log(e);
    res.render('error', {
      err: e
    })
  }
});

app.get('/quote-image/:filename', async (req, res) => {
  try {
    const { filename } = req.params;

    const [hash, ext, ...more] = filename.split('.');
    assert(/^[0-9a-z]+$/i.test(hash) && isValidImageExt('.' + ext) && !more.length);

    sendQuoteImage(res, filename);
  } catch (e) {
    res.render('error', {
      err: e
    })
  }
});

app.get('/api/quote/:id/vote', async (req, res) => {
  try {
    const quote = await Quote.findById(req.params.id);
    assert(quote, "这条语录消失了……");

    const result = await quote.getVoteSummary(res.locals.user);

    res.send({
      success: true,
      result
    });
  } catch (e) {
    syzoj.log(e);
    res.send({
      success: false,
      error: e.message
    });
  }
});

app.post('/api/quote/:id/vote/:vote', async (req, res) => {
  try {
    const { user } = res.locals;

    const quote = await Quote.findById(req.params.id);
    assert(quote, "这条语录消失了……");

    const voteType = parseInt(req.params.vote);
    assert([1, -1, 0].includes(voteType));

    await quote.setVoteBy(user, voteType);

    const result = await quote.getVoteSummary(user);

    res.send({
      error: null,
      result
    });
  } catch (e) {
    syzoj.log(e);
    res.send({
      error: e.message
    });
  }
});

app.get('/quotes', async (req, res) => {
  try {
    const { user } = res.locals;
    const allowedManage = await user.hasPrivilege('manage_quote');

    res.render('quotes', {
      allowedManage
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', {
      err: e
    })
  }
});

app.get('/api/quote/list', async (req, res) => {
  try {
    const { user } = res.locals;
    const allowedManage = await user.hasPrivilege('manage_quote');

    const currPage = parseInt(req.query.p || 1);
    const perPage = parseInt(req.query.c);
    assert(!isNaN(currPage) && currPage > 0);
    assert(!isNaN(perPage) && perPage > 0 && perPage <= 50);

    const query = Quote.createQueryBuilder().select();

    {
      let isFirst = true;
      const setWhere = (...arg) => {
        if (isFirst) {
          query.where(...arg);
          isFirst = false;
        } else {
          query.andWhere(...arg);
        }
      };

      const { type, from, provider } = req.query;

      if (allowedManage) {
        if (provider) {
          assert(syzoj.utils.isValidUsername(provider), "来源名字过于奇怪");
          const user = /^[0-9]+$/.test(provider)
            ? await User.findById(provider)
            : await User.fromName(provider);
          assert(user, "用户不存在");
          setWhere('provider_id = :id', { id: user.id });
        }
      } else {
        setWhere('provider_id = :id', { id: user.id });
      }

      if (type) {
        assert(['hitokoto', 'image'].includes(type));
        setWhere('`type` = :type', { type });
      }

      if (from) {
        assert(typeof from === 'string' && syzoj.utils.isValidUsername(from), "来源名字过于奇怪");
        setWhere('id IN (SELECT DISTINCT quote_id AS id FROM quote_from WHERE `from` = :from)', { from });
      }

      query.orderBy('update_time', 'DESC');
    }

    const count = await Quote.countForPagination(query);
    const paginate = syzoj.utils.paginate(count, currPage, perPage);
    const quotes = await Quote.queryPage(paginate, query);

    const result = await Promise.all(quotes.map(quote => processQuote(quote, user, true)));

    res.send({
      error: null,
      paginate: paginate.toJSON(),
      result
    });
  } catch (e) {
    syzoj.log(e);
    res.send({
      error: e.message
    });
  }
});

app.post('/api/quote/:id/edit', app.multer.array('files'), async (req, res) => {
  try {
    const { user } = res.locals;
    const data = JSON.parse(req.body.data);

    assert(typeof data === 'object');
    assert(['hitokoto', 'image'].includes(data.type));

    assert(Array.isArray(data.from));
    assert(data.from.length, "至少要有一个来源");
    assert(data.from.every(name =>
      typeof name === 'string' && syzoj.utils.isValidUsername(name)), "来源名字过于奇怪");

    const isNew = data.id === null;
    const quotes = [];
    const results = [];

    const createQuote = () =>
      Quote.create({
        type: data.type,
        content: {},
        provider_id: user.id,
        weight: 1,
        creation_time: new Date()
      });

    const findQuoteOrCreate = async () => {
      if (isNew) {
        return createQuote();
      } else {
        assert(Number.isSafeInteger(data.id));
        const quote = await Quote.findById(data.id);
        assert(quote !== null, "语录不存在");
        return quote;
      }
    };

    switch (data.type) {
      case 'hitokoto':
        assert(typeof data.content === 'object');
        assert(typeof data.content.hitokoto === 'string');
        assert(data.content.hitokoto.length > 0, "内容不能为空");
        assert(typeof data.content.is_dialog === 'boolean');

        const quote = await findQuoteOrCreate();

        quote.content.hitokoto = data.content.hitokoto;
        quote.content.is_dialog = data.content.is_dialog;

        quotes.push(quote);
        break;

      case 'image':
        if (isNew) {
          assert(Array.isArray(req.files) && req.files.length > 0, "至少要有一张图片");

          for (const file of req.files) {
            const quote = createQuote();

            try {
              await quote.setImage({
                filename: file.originalname,
                path: file.path,
                size: file.size
              });

              quotes.push(quote);
              results.push(`${file.originalname} 上传成功`);
            } catch (err) {
              syzoj.log(err);
              results.push(`${file.originalname} 上传失败：${err.message}`);
            }
          }
        }
        break;
    }

    for (const quote of quotes) {
      quote.update_time = new Date();
      await quote.save();
      await quote.setFrom(data.from, isNew);
    }

    res.send({
      error: null,
      result: results
    });
  } catch (e) {
    syzoj.log(e);
    res.send({
      error: e.message
    });
  }
});

app.post('/api/quote/:id/delete', async (req, res) => {
  try {
    const { user } = res.locals;

    const quote = await Quote.findById(req.params.id);
    assert(quote, "这条语录消失了……");

    const allowedManage = await user.hasPrivilege('manage_quote');
    assert(allowedManage || quote.provider_id === user.id, "不敢乱删语录啊");

    await quote.delete();

    res.send({
      error: null
    });
  } catch (e) {
    syzoj.log(e);
    res.send({
      error: e.message
    });
  }
});
